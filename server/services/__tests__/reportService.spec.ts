import { beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { openDatabase, type Db } from '../../db/client'
import { engineRuns, findings, scans, sites } from '../../db/schema'
import { createSiteCipher } from '../../domain/headerCipher'
import { createSite, type SiteServiceDeps } from '../siteService'
import { getScanDetail, getSiteHistory, previousDoneScanId } from '../reportService'
import { setTriage, triageForSite } from '../triageService'
import { SiteInputSchema } from '#shared/schemas/site'
import type { FindingRow } from '../../db/schema'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const base = SiteInputSchema.parse({
  name: 'shop',
  frontBaseUrl: 'http://localhost:3001/',
  nucleiPaths: '/\n/api/products',
  openapiUrl: 'http://localhost:3001/openapi.json',
})

let db: Db
let siteDeps: SiteServiceDeps
let n = 0
const detailDeps = {
  env: { nucleiMaxMinutes: 60, httpxMaxMinutes: 5, dalfoxMaxMinutes: 10, engineGraceMinutes: 10 },
  now: () => new Date('2026-01-01T00:07:00Z'),
}

beforeEach(() => {
  n = 0
  db = openDatabase({ file: ':memory:', migrationsFolder })
  siteDeps = {
    db,
    cipher: createSiteCipher(randomBytes(32).toString('base64')),
    now: () => new Date('2026-01-01T00:00:00Z'),
    id: () => `site-${++n}`,
  }
})

function insertScan(
  overrides: Partial<typeof scans.$inferInsert> & {
    id: string
    siteId: string
    createdAt: string
  },
) {
  db.insert(scans)
    .values({
      status: 'done',
      engines: ['nuclei'],
      siteSnapshot: {
        name: 'shop',
        frontBaseUrl: 'http://localhost:3001/',
        apiBaseUrl: null,
        nucleiPaths: '/\n/api/products',
        openapiUrl: 'http://localhost:3001/openapi.json',
        hasOpenapiJson: false,
        zapFeSeedPath: '/',
        discoverySeedPaths: '',
        crawlScopePaths: '',
        excludePaths: '',
        nucleiRateLimit: 50,
        zapApiMaxMinutes: 45,
        zapFeSpiderMaxMinutes: 5,
        nonLocalConfirmed: false,
        allowMutatingRequests: false,
        nucleiEnabledRiskTags: [],
        headerNames: [],
        browserStorageNames: [],
        requiresConfirmation: false,
      },
      error: null,
      startedAt: overrides.createdAt,
      finishedAt: overrides.createdAt,
      ...overrides,
    })
    .run()
}

function insertEngineRun(row: {
  id: string
  scanId: string
  startedAt: string
  counts?: { critical: number; high: number; medium: number; low: number; info: number }
  engine?: 'nuclei' | 'zap-api' | 'zap-fe'
  meta?: Record<string, unknown>
}) {
  db.insert(engineRuns)
    .values({
      id: row.id,
      scanId: row.scanId,
      engine: row.engine ?? 'nuclei',
      status: 'done',
      startedAt: row.startedAt,
      finishedAt: row.startedAt,
      exitCode: 0,
      signal: null,
      counts: row.counts ?? { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      meta: row.meta ?? {},
      warnings: [],
      error: null,
    })
    .run()
}

function insertFinding(row: {
  id: string
  scanId: string
  engineRunId: string
  fingerprint: string
  ruleId?: string
  severity?: FindingRow['severity']
  url?: string
}) {
  db.insert(findings)
    .values({
      id: row.id,
      scanId: row.scanId,
      engineRunId: row.engineRunId,
      engine: 'nuclei',
      ruleId: row.ruleId ?? 'rule-1',
      name: 'Some finding',
      severity: row.severity ?? 'high',
      url: row.url ?? 'http://localhost:3001/',
      method: 'GET',
      param: null,
      evidence: null,
      description: null,
      solution: null,
      reference: null,
      fingerprint: row.fingerprint,
      raw: {},
    })
    .run()
}

describe('reportService', () => {
  it('previousDoneScanId finds the latest done scan before a given scan, excluding itself', () => {
    const site = createSite(siteDeps, base)
    insertScan({ id: 'scan-1', siteId: site.id, status: 'done', createdAt: '2026-01-01T00:00:00Z' })
    insertScan({
      id: 'scan-failed',
      siteId: site.id,
      status: 'failed',
      createdAt: '2026-01-02T00:00:00Z',
    })
    insertScan({ id: 'scan-2', siteId: site.id, status: 'done', createdAt: '2026-01-03T00:00:00Z' })

    expect(
      previousDoneScanId(db, site.id, { id: 'scan-2', createdAt: '2026-01-03T00:00:00Z' }),
    ).toBe('scan-1')
    expect(
      previousDoneScanId(db, site.id, { id: 'scan-1', createdAt: '2026-01-01T00:00:00Z' }),
    ).toBeNull()
  })

  describe('getScanDetail', () => {
    it('returns null for a missing scan', () => {
      expect(getScanDetail(db, 'nope', detailDeps)).toBeNull()
    })

    it('builds diff against the previous done scan, marking new/persisting findings', () => {
      const site = createSite(siteDeps, base)
      insertScan({
        id: 'scan-1',
        siteId: site.id,
        status: 'done',
        createdAt: '2026-01-01T00:00:00Z',
      })
      insertEngineRun({ id: 'run-1', scanId: 'scan-1', startedAt: '2026-01-01T00:00:00Z' })
      insertFinding({ id: 'f-a', scanId: 'scan-1', engineRunId: 'run-1', fingerprint: 'A' })
      insertFinding({ id: 'f-b', scanId: 'scan-1', engineRunId: 'run-1', fingerprint: 'B' })

      insertScan({
        id: 'scan-failed',
        siteId: site.id,
        status: 'failed',
        createdAt: '2026-01-02T00:00:00Z',
      })

      insertScan({
        id: 'scan-2',
        siteId: site.id,
        status: 'done',
        createdAt: '2026-01-03T00:00:00Z',
      })
      insertEngineRun({ id: 'run-2', scanId: 'scan-2', startedAt: '2026-01-03T00:00:00Z' })
      insertFinding({ id: 'f-b2', scanId: 'scan-2', engineRunId: 'run-2', fingerprint: 'B' })
      insertFinding({ id: 'f-c', scanId: 'scan-2', engineRunId: 'run-2', fingerprint: 'C' })

      const detail1 = getScanDetail(db, 'scan-1', detailDeps)
      expect(detail1?.diff).toBeNull()
      expect(detail1?.findings.every((f) => f.isNew)).toBe(true)

      const detail2 = getScanDetail(db, 'scan-2', detailDeps)
      expect(detail2).not.toBeNull()
      expect(detail2?.siteName).toBe('shop')
      expect(detail2?.diff?.previousScanId).toBe('scan-1')
      expect(detail2?.diff?.newCount).toBe(1)
      expect(detail2?.diff?.persistingCount).toBe(1)
      expect(detail2?.diff?.resolved).toHaveLength(1)
      expect(detail2?.diff?.resolved[0]?.fingerprint).toBe('A')
      expect(detail2?.diff?.resolved[0]?.isNew).toBe(false)

      const findingC = detail2?.findings.find((f) => f.fingerprint === 'C')
      const findingB = detail2?.findings.find((f) => f.fingerprint === 'B')
      expect(findingC?.isNew).toBe(true)
      expect(findingB?.isNew).toBe(false)
    })

    it('dedupes diff.resolved by fingerprint when the previous scan reported it twice', () => {
      const site = createSite(siteDeps, base)
      insertScan({
        id: 'scan-1',
        siteId: site.id,
        status: 'done',
        createdAt: '2026-01-01T00:00:00Z',
      })
      insertEngineRun({ id: 'run-1', scanId: 'scan-1', startedAt: '2026-01-01T00:00:00Z' })
      // Two finding rows sharing one fingerprint (e.g. two engine runs
      // reporting the same underlying issue) — `resolved` must still count
      // it once, matching the unique-fingerprint count in newCount/persistingCount.
      insertFinding({
        id: 'f-a1',
        scanId: 'scan-1',
        engineRunId: 'run-1',
        fingerprint: 'A',
        ruleId: 'rule-a',
      })
      insertFinding({
        id: 'f-a2',
        scanId: 'scan-1',
        engineRunId: 'run-1',
        fingerprint: 'A',
        ruleId: 'rule-a-dup',
      })

      insertScan({
        id: 'scan-2',
        siteId: site.id,
        status: 'done',
        createdAt: '2026-01-02T00:00:00Z',
      })
      insertEngineRun({ id: 'run-2', scanId: 'scan-2', startedAt: '2026-01-02T00:00:00Z' })

      const detail = getScanDetail(db, 'scan-2', detailDeps)
      expect(detail?.diff?.resolved).toHaveLength(1)
      expect(detail?.diff?.resolved[0]?.fingerprint).toBe('A')
    })

    it('orders engineRuns by startedAt and findings by severity, ruleId, url', () => {
      const site = createSite(siteDeps, base)
      insertScan({
        id: 'scan-1',
        siteId: site.id,
        status: 'done',
        createdAt: '2026-01-01T00:00:00Z',
      })
      insertEngineRun({ id: 'run-b', scanId: 'scan-1', startedAt: '2026-01-01T00:05:00Z' })
      insertEngineRun({ id: 'run-a', scanId: 'scan-1', startedAt: '2026-01-01T00:00:00Z' })
      insertFinding({
        id: 'f-1',
        scanId: 'scan-1',
        engineRunId: 'run-a',
        fingerprint: 'x1',
        severity: 'medium',
        ruleId: 'r2',
        url: 'http://localhost:3001/b',
      })
      insertFinding({
        id: 'f-2',
        scanId: 'scan-1',
        engineRunId: 'run-a',
        fingerprint: 'x2',
        severity: 'critical',
        ruleId: 'r1',
        url: 'http://localhost:3001/a',
      })
      insertFinding({
        id: 'f-3',
        scanId: 'scan-1',
        engineRunId: 'run-a',
        fingerprint: 'x3',
        severity: 'medium',
        ruleId: 'r1',
        url: 'http://localhost:3001/a',
      })

      const detail = getScanDetail(db, 'scan-1', detailDeps)
      expect(detail?.engineRuns.map((r) => r.id)).toEqual(['run-a', 'run-b'])
      expect(detail?.findings.map((f) => f.id)).toEqual(['f-2', 'f-3', 'f-1'])
    })

    it('stamps the server clock as now and reports the budget an engine recorded (#84)', () => {
      const site = createSite(siteDeps, base)
      insertScan({ id: 'scan-1', siteId: site.id, createdAt: '2026-01-01T00:00:00Z' })
      const timeBudget = { parts: [{ label: 'active scan', minutes: 45 }], totalMinutes: 45 }
      insertEngineRun({
        id: 'run-a',
        scanId: 'scan-1',
        startedAt: '2026-01-01T00:00:00Z',
        engine: 'zap-api',
        meta: { timeBudget },
      })

      const detail = getScanDetail(db, 'scan-1', detailDeps)
      expect(detail?.now).toBe('2026-01-01T00:07:00.000Z')
      expect(detail?.engineRuns[0]?.limits).toEqual({ ...timeBudget, estimated: false })
    })

    it('estimates the budget from the snapshot and env for a run that recorded none (#84)', () => {
      const site = createSite(siteDeps, base)
      insertScan({ id: 'scan-1', siteId: site.id, createdAt: '2026-01-01T00:00:00Z' })
      insertEngineRun({ id: 'run-n', scanId: 'scan-1', startedAt: '2026-01-01T00:00:00Z' })
      insertEngineRun({
        id: 'run-fe',
        scanId: 'scan-1',
        startedAt: '2026-01-01T00:01:00Z',
        engine: 'zap-fe',
        meta: { domXssProbed: 2 },
      })

      const detail = getScanDetail(db, 'scan-1', detailDeps)
      const [nuclei, zapFe] = detail?.engineRuns ?? []
      expect(nuclei?.limits).toEqual({
        parts: [
          { label: 'httpx probe (SAKUDA_HTTPX_MAX_MINUTES)', minutes: 5 },
          { label: 'nuclei (SAKUDA_NUCLEI_MAX_MINUTES)', minutes: 60 },
        ],
        totalMinutes: 65,
        estimated: true,
      })
      // snapshot: spider 5 min ×2, passive 5, grace 10, DOM probe 10 (it ran), no active scan
      expect(zapFe?.limits.estimated).toBe(true)
      expect(zapFe?.limits.parts.map((p) => p.label)).toEqual([
        'spider (traditional + ajax)',
        'DOM XSS probe',
        'passive scan',
        'shutdown grace',
      ])
      expect(zapFe?.limits.totalMinutes).toBe(10 + 10 + 5 + 10)
    })

    it('falls back to the site snapshot name when the site row is gone', () => {
      const site = createSite(siteDeps, base)
      insertScan({
        id: 'scan-1',
        siteId: site.id,
        status: 'done',
        createdAt: '2026-01-01T00:00:00Z',
      })
      // The schema cascade-deletes scans when their site is deleted, which
      // would make this scenario unreachable through the app's own code
      // paths (deleteSite). Toggle the FK pragma off just for this delete so
      // the fixture can exercise the defensive "site row is gone" branch.
      db.run(sql`PRAGMA foreign_keys = OFF`)
      db.delete(sites).where(eq(sites.id, site.id)).run()
      db.run(sql`PRAGMA foreign_keys = ON`)

      const detail = getScanDetail(db, 'scan-1', detailDeps)
      expect(detail?.siteName).toBe('shop')
    })
  })

  describe('getSiteHistory', () => {
    it('returns points oldest-first with diff null for failed scans and for the first done scan', () => {
      const site = createSite(siteDeps, base)
      insertScan({
        id: 'scan-1',
        siteId: site.id,
        status: 'done',
        createdAt: '2026-01-01T00:00:00Z',
      })
      insertEngineRun({
        id: 'run-1',
        scanId: 'scan-1',
        startedAt: '2026-01-01T00:00:00Z',
        counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      })
      insertFinding({ id: 'f-a', scanId: 'scan-1', engineRunId: 'run-1', fingerprint: 'A' })
      insertFinding({ id: 'f-b', scanId: 'scan-1', engineRunId: 'run-1', fingerprint: 'B' })

      insertScan({
        id: 'scan-failed',
        siteId: site.id,
        status: 'failed',
        createdAt: '2026-01-02T00:00:00Z',
      })
      insertEngineRun({
        id: 'run-failed',
        scanId: 'scan-failed',
        startedAt: '2026-01-02T00:00:00Z',
        counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
      })

      insertScan({
        id: 'scan-2',
        siteId: site.id,
        status: 'done',
        createdAt: '2026-01-03T00:00:00Z',
      })
      insertEngineRun({
        id: 'run-2',
        scanId: 'scan-2',
        startedAt: '2026-01-03T00:00:00Z',
        counts: { critical: 0, high: 2, medium: 0, low: 0, info: 0 },
      })
      insertFinding({ id: 'f-b2', scanId: 'scan-2', engineRunId: 'run-2', fingerprint: 'B' })
      insertFinding({ id: 'f-c', scanId: 'scan-2', engineRunId: 'run-2', fingerprint: 'C' })

      const history = getSiteHistory(db, site.id)
      expect(history.map((p) => p.scanId)).toEqual(['scan-1', 'scan-failed', 'scan-2'])
      expect(history[0]?.diff).toBeNull()
      expect(history[1]?.diff).toBeNull()
      expect(history[1]?.status).toBe('failed')
      expect(history[1]?.counts).toEqual({ critical: 0, high: 0, medium: 1, low: 0, info: 0 })
      expect(history[2]?.diff).toEqual({ new: 1, persisting: 1, resolved: 1, suppressed: 0 })
      expect(history[0]?.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 0, info: 0 })
      expect(history[0]?.engines.nuclei).toEqual({
        critical: 1,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      })
    })

    it('returns an empty array for a site with no done/failed scans', () => {
      const site = createSite(siteDeps, base)
      expect(getSiteHistory(db, site.id)).toEqual([])
    })
  })
})

describe('finding triage (#18)', () => {
  const triageDeps = () => ({ db, now: () => new Date('2026-01-05T00:00:00Z') })

  /** scan-1 reports A; scan-2 (later) reports A, B, C — B and C are new by
   * fingerprint. */
  function seedTwoScans() {
    const site = createSite(siteDeps, base)
    insertScan({ id: 'scan-1', siteId: site.id, createdAt: '2026-01-01T00:00:00Z' })
    insertEngineRun({ id: 'run-1', scanId: 'scan-1', startedAt: '2026-01-01T00:00:00Z' })
    insertFinding({ id: 'f-a1', scanId: 'scan-1', engineRunId: 'run-1', fingerprint: 'A' })
    insertScan({ id: 'scan-2', siteId: site.id, createdAt: '2026-01-02T00:00:00Z' })
    insertEngineRun({ id: 'run-2', scanId: 'scan-2', startedAt: '2026-01-02T00:00:00Z' })
    insertFinding({ id: 'f-a2', scanId: 'scan-2', engineRunId: 'run-2', fingerprint: 'A' })
    insertFinding({ id: 'f-b2', scanId: 'scan-2', engineRunId: 'run-2', fingerprint: 'B' })
    insertFinding({ id: 'f-c2', scanId: 'scan-2', engineRunId: 'run-2', fingerprint: 'C' })
    return site
  }

  it('false-positive / accepted findings do not count as new in later scans; confirmed does', () => {
    seedTwoScans()
    // Verdicts recorded on findings of scan-2 itself carry over by fingerprint.
    setTriage(triageDeps(), {
      findingId: 'f-b2',
      status: 'false-positive',
      reason: 'not reflected',
    })
    setTriage(triageDeps(), { findingId: 'f-c2', status: 'confirmed', reason: 'reproduced' })

    const detail = getScanDetail(db, 'scan-2', detailDeps)
    expect(detail?.diff?.newCount).toBe(1)
    expect(detail?.diff?.suppressedCount).toBe(1)
    expect(detail?.diff?.persistingCount).toBe(1)
    const byFp = new Map(detail?.findings.map((f) => [f.fingerprint, f]))
    expect(byFp.get('B')?.isNew).toBe(false)
    expect(byFp.get('B')?.triage).toEqual({
      status: 'false-positive',
      reason: 'not reflected',
      updatedAt: '2026-01-05T00:00:00.000Z',
    })
    expect(byFp.get('C')?.isNew).toBe(true)
    expect(byFp.get('C')?.triage?.status).toBe('confirmed')
    expect(byFp.get('A')?.triage).toBeNull()

    const history = getSiteHistory(db, detail!.siteId)
    expect(history.at(-1)?.diff).toEqual({ new: 1, persisting: 1, resolved: 0, suppressed: 1 })
  })

  it('a verdict on an earlier scan’s finding applies when it shows up again later', () => {
    const site = createSite(siteDeps, base)
    insertScan({ id: 'scan-1', siteId: site.id, createdAt: '2026-01-01T00:00:00Z' })
    insertEngineRun({ id: 'run-1', scanId: 'scan-1', startedAt: '2026-01-01T00:00:00Z' })
    insertFinding({ id: 'f-x1', scanId: 'scan-1', engineRunId: 'run-1', fingerprint: 'X' })
    setTriage(triageDeps(), { findingId: 'f-x1', status: 'accepted', reason: 'known risk' })
    insertScan({ id: 'scan-2', siteId: site.id, createdAt: '2026-01-02T00:00:00Z' })
    insertEngineRun({ id: 'run-2', scanId: 'scan-2', startedAt: '2026-01-02T00:00:00Z' })
    insertScan({ id: 'scan-3', siteId: site.id, createdAt: '2026-01-03T00:00:00Z' })
    insertEngineRun({ id: 'run-3', scanId: 'scan-3', startedAt: '2026-01-03T00:00:00Z' })
    insertFinding({ id: 'f-x3', scanId: 'scan-3', engineRunId: 'run-3', fingerprint: 'X' })

    const detail = getScanDetail(db, 'scan-3', detailDeps)
    expect(detail?.diff?.newCount).toBe(0)
    expect(detail?.diff?.suppressedCount).toBe(1)
    expect(detail?.findings[0]).toMatchObject({ isNew: false, triage: { status: 'accepted' } })
    // scan-2 resolved X; the resolved list carries the verdict too
    expect(getScanDetail(db, 'scan-2', detailDeps)?.diff?.resolved[0]?.triage?.status).toBe(
      'accepted',
    )
  })

  it('is idempotent: re-sending the same verdict changes nothing, a new one overwrites', () => {
    const site = seedTwoScans()
    const first = setTriage(triageDeps(), {
      findingId: 'f-b2',
      status: 'false-positive',
      reason: 'r',
    })
    const later = () => ({ db, now: () => new Date('2026-02-01T00:00:00Z') })
    const again = setTriage(later(), { findingId: 'f-b2', status: 'false-positive', reason: 'r' })
    expect(again).toEqual(first)
    expect(triageForSite(db, site.id).size).toBe(1)

    const changed = setTriage(later(), { findingId: 'f-b2', status: 'confirmed', reason: 'r2' })
    expect(changed.triage).toEqual({
      status: 'confirmed',
      reason: 'r2',
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
    expect(triageForSite(db, site.id).size).toBe(1)
    expect(getScanDetail(db, 'scan-2', detailDeps)?.diff?.newCount).toBe(2)
  })

  it('rejects an unknown finding with 404', () => {
    expect(() =>
      setTriage(triageDeps(), { findingId: 'nope', status: 'accepted', reason: 'r' }),
    ).toThrow(expect.objectContaining({ statusCode: 404, code: 'FINDING_NOT_FOUND' }))
  })

  it('is per site: the same fingerprint on another site still counts as new', () => {
    seedTwoScans()
    setTriage(triageDeps(), { findingId: 'f-b2', status: 'false-positive', reason: 'r' })
    const other = createSite(siteDeps, base)
    insertScan({ id: 'scan-o', siteId: other.id, createdAt: '2026-01-04T00:00:00Z' })
    insertEngineRun({ id: 'run-o', scanId: 'scan-o', startedAt: '2026-01-04T00:00:00Z' })
    insertFinding({ id: 'f-bo', scanId: 'scan-o', engineRunId: 'run-o', fingerprint: 'B' })
    expect(getScanDetail(db, 'scan-o', detailDeps)?.findings[0]).toMatchObject({
      isNew: true,
      triage: null,
    })
  })
})
