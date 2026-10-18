import { and, asc, desc, eq, inArray, lt, ne } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  engineRuns,
  findings,
  scans,
  sites,
  type EngineRunRow,
  type FindingRow,
} from '../db/schema'
import { diffFingerprints } from '../domain/diff'
import { isActiveScanEnabled } from '../domain/activeScan'
import {
  engineTimeBudget,
  recordedTimeBudget,
  type TimeBudgetEnv,
} from '../domain/engineTimeBudget'
import { countsForScan, toScanSummary } from './scanService'
import { suppressedFingerprints, triageForSite } from './triageService'
import type {
  Engine,
  EngineRunView,
  FindingTriageView,
  FindingView,
  HistoryPoint,
  ScanDetail,
  SeverityCounts,
} from '#shared/types/api'
import { addCounts, emptyCounts, severityRank } from '#shared/utils/severity'

/** Inputs `getScanDetail` needs beyond the database: the env the budget
 * fallback reads, and the clock the response stamps as `now`. */
export interface ScanDetailDeps {
  env: TimeBudgetEnv
  now: () => Date
}

/** The run's time budget as recorded by the engine, or — for a run that
 * predates the recording — an estimate from the site snapshot and the
 * current env, flagged as such so the page can say so (#84). */
function runLimits(
  row: EngineRunRow,
  snapshot: SiteSnapshot,
  env: TimeBudgetEnv,
): EngineRunView['limits'] {
  const recorded = recordedTimeBudget(row.meta)
  if (recorded) return { ...recorded, estimated: false }
  const estimate = engineTimeBudget(row.engine, snapshot, env, {
    activeScan: isActiveScanEnabled(snapshot),
    // zap-fe's probe ran iff it reported a probe count
    domXssProbe: typeof row.meta.domXssProbed === 'number',
  })
  return { ...estimate, estimated: true }
}

function toEngineRunView(
  row: EngineRunRow,
  snapshot: SiteSnapshot,
  env: TimeBudgetEnv,
): EngineRunView {
  return {
    id: row.id,
    engine: row.engine,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    exitCode: row.exitCode,
    signal: row.signal,
    counts: row.counts,
    meta: row.meta,
    warnings: row.warnings,
    error: row.error,
    limits: runLimits(row, snapshot, env),
  }
}

function toFindingView(
  row: FindingRow,
  isNew: boolean,
  triage: FindingTriageView | null,
): FindingView {
  return {
    id: row.id,
    engine: row.engine,
    ruleId: row.ruleId,
    name: row.name,
    severity: row.severity,
    url: row.url,
    method: row.method,
    param: row.param,
    evidence: row.evidence,
    description: row.description,
    solution: row.solution,
    reference: row.reference,
    fingerprint: row.fingerprint,
    isNew,
    triage,
  }
}

/** Severity rank, then ruleId, then url — ascending, stable for ties. */
function sortFindingRows(rows: FindingRow[]): FindingRow[] {
  return [...rows].sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity)
    if (bySeverity !== 0) return bySeverity
    const byRuleId = a.ruleId.localeCompare(b.ruleId)
    if (byRuleId !== 0) return byRuleId
    return a.url.localeCompare(b.url)
  })
}

function findingsForScan(db: Db, scanId: string): FindingRow[] {
  return db.select().from(findings).where(eq(findings.scanId, scanId)).all()
}

/** Keeps the first row per fingerprint so a caller counting unique
 * fingerprints (e.g. `diffFingerprints`'s `resolved` count) gets a matching
 * row count, even if multiple finding rows share a fingerprint. */
function dedupeByFingerprint(rows: FindingRow[]): FindingRow[] {
  const seen = new Set<string>()
  const result: FindingRow[] = []
  for (const row of rows) {
    if (seen.has(row.fingerprint)) continue
    seen.add(row.fingerprint)
    result.push(row)
  }
  return result
}

/** Latest `done` scan of the site strictly before `before.createdAt`
 * (excluding `before.id` itself as a tie-break for equal timestamps). */
export function previousDoneScanId(
  db: Db,
  siteId: string,
  before: { createdAt: string; id: string },
): string | null {
  const row = db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        eq(scans.siteId, siteId),
        eq(scans.status, 'done'),
        lt(scans.createdAt, before.createdAt),
        ne(scans.id, before.id),
      ),
    )
    .orderBy(desc(scans.createdAt))
    .limit(1)
    .get()
  return row ? row.id : null
}

export function getScanDetail(db: Db, scanId: string, deps: ScanDetailDeps): ScanDetail | null {
  const scanRow = db.select().from(scans).where(eq(scans.id, scanId)).get()
  if (!scanRow) return null

  const siteRow = db.select().from(sites).where(eq(sites.id, scanRow.siteId)).get()
  const siteName = siteRow ? siteRow.name : scanRow.siteSnapshot.name

  const engineRunRows = db
    .select()
    .from(engineRuns)
    .where(eq(engineRuns.scanId, scanId))
    .orderBy(asc(engineRuns.startedAt))
    .all()

  const currentFindingRows = sortFindingRows(findingsForScan(db, scanId))
  const currentFingerprints = currentFindingRows.map((f) => f.fingerprint)

  // Verdicts are per site + fingerprint (#18): one triaged as false-positive /
  // accepted on any scan stops counting as new on this one.
  const triage = triageForSite(db, scanRow.siteId)
  const suppressed = suppressedFingerprints(triage)

  const previousScanId = previousDoneScanId(db, scanRow.siteId, {
    createdAt: scanRow.createdAt,
    id: scanRow.id,
  })

  let previousFingerprints = new Set<string>()
  let diff: ScanDetail['diff'] = null
  if (previousScanId) {
    const previousFindingRows = findingsForScan(db, previousScanId)
    previousFingerprints = new Set(previousFindingRows.map((f) => f.fingerprint))
    const currentFingerprintSet = new Set(currentFingerprints)
    const counts = diffFingerprints(previousFingerprints, currentFingerprintSet, suppressed)
    const resolved = dedupeByFingerprint(
      previousFindingRows.filter((f) => !currentFingerprintSet.has(f.fingerprint)),
    ).map((f) => toFindingView(f, false, triage.get(f.fingerprint) ?? null))
    diff = {
      previousScanId,
      newCount: counts.new,
      persistingCount: counts.persisting,
      suppressedCount: counts.suppressed,
      resolved,
    }
  }

  const findingViews = currentFindingRows.map((f) =>
    toFindingView(
      f,
      !previousFingerprints.has(f.fingerprint) && !suppressed.has(f.fingerprint),
      triage.get(f.fingerprint) ?? null,
    ),
  )

  return {
    ...toScanSummary(scanRow, countsForScan(db, scanId)),
    siteName,
    siteSnapshot: scanRow.siteSnapshot,
    engineRuns: engineRunRows.map((r) => toEngineRunView(r, scanRow.siteSnapshot, deps.env)),
    findings: findingViews,
    diff,
    now: deps.now().toISOString(),
  }
}

export function getSiteHistory(db: Db, siteId: string): HistoryPoint[] {
  const scanRows = db
    .select()
    .from(scans)
    .where(and(eq(scans.siteId, siteId), inArray(scans.status, ['done', 'failed'])))
    .orderBy(asc(scans.createdAt))
    .all()

  const suppressed = suppressedFingerprints(triageForSite(db, siteId))
  let lastDoneFingerprints: Set<string> | null = null

  return scanRows.map((scan) => {
    const engineRunRows = db.select().from(engineRuns).where(eq(engineRuns.scanId, scan.id)).all()
    const engineCounts: Partial<Record<Engine, SeverityCounts>> = {}
    for (const run of engineRunRows) engineCounts[run.engine] = run.counts

    const counts = engineRunRows.reduce((acc, r) => addCounts(acc, r.counts), emptyCounts())

    let diff: HistoryPoint['diff'] = null
    if (scan.status === 'done') {
      const currentFingerprints = new Set(findingsForScan(db, scan.id).map((f) => f.fingerprint))
      if (lastDoneFingerprints)
        diff = diffFingerprints(lastDoneFingerprints, currentFingerprints, suppressed)
      lastDoneFingerprints = currentFingerprints
    }

    return {
      scanId: scan.id,
      createdAt: scan.createdAt,
      finishedAt: scan.finishedAt,
      status: scan.status,
      counts,
      engines: engineCounts,
      diff,
    }
  })
}
