import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { engineRuns, scans, sites, type ScanRow } from '../db/schema'
import { toSitePublic, toSiteSnapshot } from '../domain/siteView'
import { orderEngines } from '../engines'
import { hasActiveDiscovery, hasActiveScan } from './activeJobs'
import { ServiceError } from './errors'
import type { Engine, ScanSummary, SeverityCounts } from '#shared/types/api'
import { addCounts, emptyCounts } from '#shared/utils/severity'

const RESTART_ERROR = 'server restarted while the scan was running'

export function toScanSummary(row: ScanRow, counts: SeverityCounts): ScanSummary {
  return {
    id: row.id,
    siteId: row.siteId,
    status: row.status,
    engines: row.engines,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
    authLost: row.authLost ?? null,
    counts,
  }
}

export function countsForScan(db: Db, scanId: string): SeverityCounts {
  const rows = db
    .select({ counts: engineRuns.counts })
    .from(engineRuns)
    .where(eq(engineRuns.scanId, scanId))
    .all()
  return rows.reduce((acc, r) => addCounts(acc, r.counts), emptyCounts())
}

export function latestScanSummary(db: Db, siteId: string): ScanSummary | null {
  const row = db
    .select()
    .from(scans)
    .where(eq(scans.siteId, siteId))
    .orderBy(desc(scans.createdAt))
    .limit(1)
    .get()
  return row ? toScanSummary(row, countsForScan(db, row.id)) : null
}

export function listScans(db: Db, siteId: string): ScanSummary[] {
  return db
    .select()
    .from(scans)
    .where(eq(scans.siteId, siteId))
    .orderBy(desc(scans.createdAt))
    .all()
    .map((row) => toScanSummary(row, countsForScan(db, row.id)))
}

function assertEnginePrereqs(engines: Engine[], _nucleiPaths: string, hasOpenapi: boolean): void {
  for (const engine of engines) {
    // nuclei has no prerequisite: with no paths configured it scans the base URL(s).
    if (engine === 'zap-api' && !hasOpenapi) {
      throw new ServiceError(422, 'ENGINE_PREREQ', 'zap-api requires openapiUrl or openapiJson')
    }
  }
}

export function createScan(
  db: Db,
  deps: { now: () => Date; id: () => string },
  siteId: string,
  engines: Engine[],
): ScanSummary {
  const siteRow = db.select().from(sites).where(eq(sites.id, siteId)).get()
  if (!siteRow) throw new ServiceError(404, 'SITE_NOT_FOUND', `site ${siteId} not found`)
  const site = toSitePublic(siteRow)

  if (site.requiresConfirmation && !site.nonLocalConfirmed) {
    throw new ServiceError(
      422,
      'NON_LOCAL_UNCONFIRMED',
      'site targets a non-local host without confirmation',
    )
  }

  const ordered = orderEngines(engines)
  assertEnginePrereqs(
    ordered,
    site.nucleiPaths,
    site.openapiUrl !== null || site.openapiJson !== null,
  )

  if (hasActiveScan(db, siteId))
    throw new ServiceError(409, 'SCAN_ACTIVE', `site ${siteId} already has an active scan`)
  if (hasActiveDiscovery(db, siteId))
    throw new ServiceError(
      409,
      'DISCOVERY_ACTIVE',
      `site ${siteId} has an active discovery; wait for it to finish`,
    )

  const id = deps.id()
  const createdAt = deps.now().toISOString()
  const row: ScanRow = {
    id,
    siteId,
    status: 'queued',
    engines: ordered,
    siteSnapshot: toSiteSnapshot(site),
    error: null,
    authLost: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
  }
  db.insert(scans).values(row).run()

  return toScanSummary(row, emptyCounts())
}

export function claimNextQueuedScan(db: Db, now: () => Date): string | null {
  return db.transaction((tx) => {
    const next = tx
      .select({ id: scans.id })
      .from(scans)
      .where(eq(scans.status, 'queued'))
      .orderBy(scans.createdAt)
      .limit(1)
      .get()
    if (!next) return null
    const result = tx
      .update(scans)
      .set({ status: 'running', startedAt: now().toISOString() })
      .where(and(eq(scans.id, next.id), eq(scans.status, 'queued')))
      .run()
    return result.changes > 0 ? next.id : null
  })
}

export function recoverInterruptedScans(db: Db, now: () => Date): number {
  return db.transaction((tx) => {
    const running = tx.select({ id: scans.id }).from(scans).where(eq(scans.status, 'running')).all()
    if (running.length === 0) return 0
    const finishedAt = now().toISOString()
    for (const { id } of running) {
      tx.update(scans)
        .set({ status: 'failed', error: RESTART_ERROR, finishedAt })
        .where(eq(scans.id, id))
        .run()
      tx.update(engineRuns)
        .set({ status: 'failed', error: RESTART_ERROR, finishedAt })
        .where(and(eq(engineRuns.scanId, id), eq(engineRuns.status, 'running')))
        .run()
    }
    return running.length
  })
}
