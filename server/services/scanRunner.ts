import { and, eq } from 'drizzle-orm'
import { join } from 'node:path'
import type { Env } from '../config/env'
import type { Db } from '../db/client'
import { engineRuns, findings, scans } from '../db/schema'
import { buildFingerprint } from '../domain/fingerprint'
import type { SiteCipher } from '../domain/headerCipher'
import { orderEngines } from '../engines'
import { EngineError, type EngineRunner } from '../engines/types'
import type { Logger } from '../lib/logger'
import {
  AUTH_CHECK_INTERVAL_MS,
  fetchAuthStatus,
  startAuthWatch,
  type AuthCheckConfig,
  type AuthWatch,
} from './authWatch'
import { loadSiteWithHeaders } from './siteService'
import type { Engine } from '#shared/types/api'
import { emptyCounts } from '#shared/utils/severity'

export interface ScanRunnerDeps {
  db: Db
  env: Env
  cipher: SiteCipher
  runners: Record<Engine, EngineRunner>
  logger: Logger
  now: () => Date
  id: () => string
  /** Auth check sender and interval (#74); defaults to a real fetch every
   * AUTH_CHECK_INTERVAL_MS. Tests inject a fake. */
  authCheck?: AuthCheckConfig
}

/** The abort reason the job loop uses when the user stops a scan (#74), so
 * the runner can tell it apart from a server shutdown. */
export const USER_CANCEL_REASON = 'cancelled by user'

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function runScan(
  deps: ScanRunnerDeps,
  scanId: string,
  signal: AbortSignal,
): Promise<void> {
  const { db, logger } = deps
  const scan = db.select().from(scans).where(eq(scans.id, scanId)).get()
  if (!scan) {
    logger.error({ scanId }, 'scan vanished before run')
    return
  }
  // Idempotent: guards against a double call (e.g. the normal end-of-run
  // finish() followed by the crash handler below reaching for it too) so the
  // scan's terminal status is written at most once.
  let finished = false
  const finish = (status: 'done' | 'failed', error: string | null): void => {
    if (finished) return
    finished = true
    try {
      db.update(scans)
        .set({ status, error, finishedAt: deps.now().toISOString() })
        .where(eq(scans.id, scanId))
        .run()
    } catch (e) {
      logger.error({ scanId, err: e }, 'failed to write final scan status')
    }
  }
  try {
    const site = loadSiteWithHeaders(
      { db, cipher: deps.cipher, now: deps.now, id: deps.id },
      scan.siteId,
    )
    if (!site) {
      finish('failed', 'site was deleted before the scan started')
      return
    }
    if (site.requiresConfirmation && !site.nonLocalConfirmed) {
      finish('failed', 'site targets a non-local host without confirmation')
      return
    }
    const log = logger.child({ scanId, siteId: site.id })
    const cancelledByUser = (): boolean => signal.aborted && signal.reason === USER_CANCEL_REASON
    const authWatch: AuthWatch | null = startAuthWatch({
      site,
      config: deps.authCheck ?? {
        send: fetchAuthStatus(deps.env.localhostAlias),
        intervalMs: AUTH_CHECK_INTERVAL_MS,
      },
      logger: log,
      now: deps.now,
      onLost: (lost) => {
        log.warn(
          { operation: 'authCheck', path: lost.path, status: lost.status },
          'login rejected mid-scan; results after this point may be unauthenticated',
        )
        try {
          db.update(scans).set({ authLost: lost }).where(eq(scans.id, scanId)).run()
        } catch (e) {
          log.error({ err: e }, 'failed to record lost login on the scan')
        }
      },
    })
    let doneCount = 0
    let failedCount = 0
    let skippedCount = 0
    try {
      for (const engine of orderEngines(scan.engines)) {
        if (signal.aborted) {
          failedCount++
          break
        }
        const runId = deps.id()
        const startedAt = deps.now().toISOString()
        db.insert(engineRuns)
          .values({
            id: runId,
            scanId,
            engine,
            status: 'running',
            startedAt,
            counts: emptyCounts(),
            meta: {},
            warnings: [],
          })
          .run()
        const workDir = join(deps.env.scansDir, scanId, engine)
        try {
          const out = await deps.runners[engine]({
            scanId,
            engine,
            site,
            workDir,
            env: deps.env,
            logger: log,
            signal,
          })
          // A runner that skipped itself (e.g. dalfox with active checks off)
          // records a `skipped` run — neither a success nor a failure — so the
          // overall scan status is decided only by the engines that actually ran.
          const runStatus = out.skipped ? 'skipped' : 'done'
          db.transaction((tx) => {
            tx.update(engineRuns)
              .set({
                status: runStatus,
                finishedAt: deps.now().toISOString(),
                exitCode: out.exitCode,
                signal: out.signal,
                counts: out.counts,
                meta: out.meta,
                warnings: out.warnings,
              })
              .where(eq(engineRuns.id, runId))
              .run()
            for (const chunk of chunks(out.findings, 200))
              tx.insert(findings)
                .values(
                  chunk.map((f) => ({
                    id: deps.id(),
                    scanId,
                    engineRunId: runId,
                    ...f,
                    fingerprint: buildFingerprint(f),
                  })),
                )
                .run()
          })
          if (out.skipped) skippedCount++
          else doneCount++
          log.info(
            {
              engine,
              counts: out.counts,
              findings: out.findings.length,
              skipped: out.skipped === true,
            },
            out.skipped ? 'engine skipped' : 'engine done',
          )
        } catch (e) {
          const message = cancelledByUser()
            ? USER_CANCEL_REASON
            : e instanceof EngineError && e.runbook
              ? `${e.message}\nRunbook: ${e.runbook}`
              : e instanceof Error
                ? e.message
                : String(e)
          db.update(engineRuns)
            .set({ status: 'failed', finishedAt: deps.now().toISOString(), error: message })
            .where(eq(engineRuns.id, runId))
            .run()
          failedCount++
          if (cancelledByUser()) log.info({ engine }, 'engine stopped: cancelled by user')
          else log.error({ engine, err: e }, 'engine failed')
        }
      }
    } finally {
      await authWatch?.stop()
    }
    if (cancelledByUser()) finish('failed', USER_CANCEL_REASON)
    else if (signal.aborted) finish('failed', 'aborted: server shutting down')
    // Every engine failed → the scan failed. But a scan whose only runs were
    // skipped (e.g. dalfox alone, active checks off) did not fail — it ran
    // nothing, and says so.
    else if (doneCount === 0 && failedCount === 0 && skippedCount > 0)
      finish('done', `all ${skippedCount} engine run(s) were skipped`)
    else if (doneCount === 0 && failedCount > 0 && skippedCount > 0)
      finish('failed', `${failedCount} engine run(s) failed, ${skippedCount} skipped`)
    else if (doneCount === 0) finish('failed', `all ${failedCount} engine run(s) failed`)
    else finish('done', failedCount ? `${failedCount} engine run(s) failed` : null)
  } catch (e) {
    // Anything outside the per-engine loop (loadSiteWithHeaders/cipher.open
    // throwing DecryptError on a rotated key or corrupt envelope, a DB error,
    // etc.) must still leave the scan in a terminal state — otherwise it is
    // stuck `running` forever and the site can never be scanned again
    // (createScan rejects while an active scan exists, and the cancel
    // endpoint only reaches a scan the job loop is running).
    const message = e instanceof Error ? e.message : String(e)
    logger.error({ scanId, err: e }, 'scan runner crashed')
    try {
      db.update(engineRuns)
        .set({
          status: 'failed',
          finishedAt: deps.now().toISOString(),
          error: 'scan runner crashed',
        })
        .where(and(eq(engineRuns.scanId, scanId), eq(engineRuns.status, 'running')))
        .run()
    } catch (e2) {
      logger.error({ scanId, err: e2 }, 'failed to mark stuck engine runs failed after crash')
    }
    finish('failed', `scan runner crashed: ${message}`)
  }
}
