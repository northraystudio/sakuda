import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isActiveScanEnabled } from '../../domain/activeScan'
import { engineTimeBudget, timeBudgetEnv } from '../../domain/engineTimeBudget'
import { expandNucleiTargets } from '../../domain/nucleiTargets'
import { rewriteLoopbackHost } from '../../domain/hostAlias'
import { emptyCounts } from '#shared/utils/severity'
import { runCommand, SpawnError } from '../runCommand'
import { writeSecretFile } from '../secretFile'
import { EngineError, type EngineOutput, type EngineRunner } from '../types'
import { buildDalfoxArgs } from './args'
import { buildDalfoxConfig, dalfoxScanTimeoutSec } from './config'
import {
  dalfoxReachability,
  dalfoxTargetOutcomes,
  normalizeDalfoxFindings,
  parseDalfoxReport,
} from './normalize'

/** First occurrence per key, order preserved. */
function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyOf(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export const runDalfox: EngineRunner = async ({ scanId, site, workDir, env, logger, signal }) => {
  // Gate: dalfox sends attack payloads, so it runs only under active checks.
  // Off → skip *before* building any config or target file, and report the run
  // as skipped (not failed) so a deliberate no-op is distinguishable from a
  // clean run and from a failure.
  if (!isActiveScanEnabled(site)) {
    logger.info({ scanId, engine: 'dalfox' }, 'dalfox skipped: active checks are off')
    return {
      findings: [],
      counts: emptyCounts(),
      warnings: [
        'dalfox was skipped because active injection checks are off for this site — enable them to run the XSS pass',
      ],
      exitCode: null,
      signal: null,
      meta: { skipped: true, reason: 'active-checks-off' },
      skipped: true,
    } satisfies EngineOutput
  }

  const { targets } = expandNucleiTargets(site)
  // GET, server-reachable (no hash routes — the fragment never reaches the
  // server, so dalfox's request-based checks cannot test them; the zap-fe DOM
  // probe owns those), deduped on URL, capped at the configured target count.
  const getUrls = uniqueBy(
    targets.filter((t) => t.method === 'GET' && !t.url.includes('#')).map((t) => t.url),
    (u) => u,
  ).slice(0, env.dalfox.maxTargets)

  if (getUrls.length === 0)
    throw new EngineError(
      'dalfox: no saved GET target URLs to scan (hash routes are excluded — they are the zap-fe DOM probe’s job)',
    )

  const alias = env.localhostAlias
  // Rewritten host:port -> original hostname, so a finding’s URL can be
  // un-aliased back to what the user saved (front and api may differ by port).
  const portToHost = new Map<string, string>()
  if (alias) {
    for (const u of getUrls) {
      try {
        const parsed = new URL(u)
        if (LOOPBACK.has(parsed.hostname)) portToHost.set(parsed.port, parsed.hostname)
      } catch {
        // non-URL saved line; nothing to map
      }
    }
  }
  const unalias = (u: string): string => {
    if (!alias || !URL.canParse(u)) return u
    const parsed = new URL(u)
    if (parsed.hostname === alias) {
      const orig = portToHost.get(parsed.port)
      if (orig) parsed.hostname = orig
    }
    return parsed.toString()
  }

  await mkdir(workDir, { recursive: true })
  const targetsFile = join(workDir, 'targets.txt')
  const configFile = join(workDir, 'dalfox-config.json')
  const outputFile = join(workDir, 'dalfox-findings.json')
  const stdoutPath = join(workDir, 'stdout.log')
  const stderrPath = join(workDir, 'stderr.log')

  // The budget is the single source for the run deadline (#84); dalfox’s own
  // per-target scan_timeout is derived from it, and runCommand hard-kills the
  // group at the total budget.
  const timeBudget = engineTimeBudget('dalfox', site, timeBudgetEnv(env), {
    activeScan: true,
    domXssProbe: false,
  })
  // Per-target scan-timeout is derived from the whole budget (see
  // dalfoxScanTimeoutSec), so one slow target cannot consume the run; runCommand
  // still hard-kills the group at the total budget.
  const scanTimeoutSec = dalfoxScanTimeoutSec(
    env.dalfox.maxMinutes * 60,
    getUrls.length,
    env.dalfox.concurrency,
  )

  logger.info(
    {
      scanId,
      engine: 'dalfox',
      urlCount: getUrls.length,
      rateLimit: site.nucleiRateLimit,
      concurrency: env.dalfox.concurrency,
      maxTargets: env.dalfox.maxTargets,
      headerNames: site.headerNames,
    },
    'dalfox start',
  )

  const warnings: string[] = []
  try {
    // Secret-artifact discipline: the config carries the site’s auth headers,
    // and the report may echo target query values; write both 0600 and
    // pre-create the tool-written output so dalfox does not create it under the
    // process umask.
    await writeSecretFile(
      targetsFile,
      getUrls.map((u) => rewriteLoopbackHost(u, alias)).join('\n') + '\n',
    )
    const config = buildDalfoxConfig({
      headers: site.headers,
      rateLimit: site.nucleiRateLimit,
      concurrency: env.dalfox.concurrency,
      maxTargets: env.dalfox.maxTargets,
      scanTimeoutSec,
    })
    await writeSecretFile(configFile, JSON.stringify(config))
    await writeSecretFile(outputFile, '')

    let result
    try {
      result = await runCommand({
        label: `dalfox:${scanId}`,
        cmd: env.dalfox.bin,
        args: buildDalfoxArgs({ targetsFile, outputFile, configFile }),
        cwd: workDir,
        stdoutPath,
        stderrPath,
        timeoutMs: timeBudget.totalMinutes * 60_000,
        signal,
        logger,
      })
    } catch (e) {
      // A spawn failure is almost always a missing binary or a bad path — surface it
      // as a runbook-friendly EngineError rather than a raw SpawnError.
      if (e instanceof SpawnError)
        throw new EngineError(
          `dalfox failed to start — check SAKUDA_DALFOX_BIN (${env.dalfox.bin}) is installed and executable`,
          undefined,
          { cause: e },
        )
      throw e
    }

    if (result.aborted) throw new EngineError('dalfox aborted: server shutting down')

    const json = existsSync(outputFile) ? await readFile(outputFile, 'utf8') : ''
    const report = parseDalfoxReport(json)
    const reach = dalfoxReachability(report.meta)
    const outcomes = dalfoxTargetOutcomes(report.meta)

    // dalfox exit 1 means it found at least one finding of any tier. If we then
    // parsed nothing at all (empty `findings` array, no unparsable entries), the
    // report is corrupt or its format drifted — fail loudly rather than silently
    // returning zero findings (a false negative). The `I` tier we later drop is
    // still present in `report.findings` here, so an I-only run does not trip this.
    if (result.code === 1 && report.findings.length === 0 && report.invalid === 0)
      throw new EngineError(
        `dalfox reported findings (exit 1) but produced no parseable report; see ${stderrPath}`,
      )

    const { findings, counts } = normalizeDalfoxFindings(report.findings, unalias)

    // dalfox exit codes: 0 = no findings, 1 = findings, 2 = hard error. But "every
    // target unreachable" also exits 2 while writing a well-formed report whose
    // target_summary marks each target skipped/CONNECTION_FAILED — the target was
    // down, not a scan error. Treat that as "unavailable" (a warning + zero
    // findings), distinct from a genuine failure, so a stopped target container
    // does not fail the engine. dalfox also exits 2 when a single target ends
    // SESSION_LOST / SCAN_TIMEOUT while the rest of the scan ran; a report whose
    // only errors are such per-target codes is a partial result (warned below),
    // not a failure. A real exit-2 error (no report, partial reachability, or
    // an unknown error code) still throws.
    const perTargetExit2 = result.code === 2 && outcomes.onlyPerTargetErrors
    if (
      result.code === 2 &&
      findings.length === 0 &&
      !result.timedOut &&
      !reach.allUnreachable &&
      !perTargetExit2
    )
      throw new EngineError(`dalfox failed (exit 2) and produced no findings; see ${stderrPath}`)

    // Whatever the exit code, if every target was unreachable, say so — a clean
    // "0 findings" would otherwise read as "nothing to find" when in fact nothing
    // was tested.
    if (reach.allUnreachable)
      warnings.push(
        `all ${reach.total} dalfox target(s) were unreachable (connection failed) — the target may be down; nothing was tested`,
      )

    if (result.timedOut) {
      warnings.push(`dalfox was stopped after ${env.dalfox.maxMinutes} min; results are partial`)
    }
    if (report.invalid > 0) warnings.push(`${report.invalid} unparsable dalfox finding(s) ignored`)
    // Name the targets dalfox cut short, by error code, so a partial run is
    // not read as "nothing to find". Skipped when all were unreachable (warned above).
    const cutShort = Object.entries(outcomes.cutShort)
    if (cutShort.length > 0 && !reach.allUnreachable) {
      const total = cutShort.reduce((n, [, c]) => n + c, 0)
      const breakdown = cutShort.map(([code, c]) => `${code} ×${c}`).join(', ')
      warnings.push(`${total} dalfox target(s) were not fully tested (${breakdown})`)
    }
    if (outcomes.cutShort.SESSION_LOST && !reach.allUnreachable)
      warnings.push(
        `${outcomes.cutShort.SESSION_LOST} dalfox target(s) already looked unauthenticated before testing (SESSION_LOST) — check the site’s auth headers are current, unless that endpoint rejects the request by design`,
      )
    // The scan-metadata envelope’s own partial-run signal, when no target says why.
    if (report.meta.incomplete === true && !result.timedOut && cutShort.length === 0)
      warnings.push('dalfox reported an incomplete scan (a target was not fully tested)')

    logger.info(
      { scanId, engine: 'dalfox', findings: findings.length, counts, timedOut: result.timedOut },
      'dalfox done',
    )

    return {
      findings,
      counts,
      warnings,
      // exit 1 (findings), all-unreachable (target down) and a per-target-only
      // exit 2 (partial, warned) are not failures — normalize them to 0.
      exitCode: result.code === 1 || reach.allUnreachable || perTargetExit2 ? 0 : result.code,
      signal: result.signal,
      meta: {
        urlCount: getUrls.length,
        rateLimit: site.nucleiRateLimit,
        concurrency: env.dalfox.concurrency,
        maxTargets: env.dalfox.maxTargets,
        scanTimeoutSec,
        timeBudget,
        totalRequests: report.meta.total_requests ?? null,
        incomplete: report.meta.incomplete === true,
        unavailable: reach.allUnreachable,
        unreachableTargets: reach.unreachable,
        cutShortTargets: outcomes.cutShort,
        timedOut: result.timedOut,
        durationSec: Math.round(result.durationMs / 1000),
      },
    } satisfies EngineOutput
  } finally {
    // The config holds the site’s auth headers — always remove it. The targets
    // file and report may carry saved query values, so remove those too;
    // stdout/stderr logs stay for diagnostics (dalfox is silenced, so they
    // hold no findings).
    for (const p of [configFile, targetsFile, outputFile]) await rm(p, { force: true })
  }
}
