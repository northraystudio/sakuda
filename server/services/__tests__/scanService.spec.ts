import { beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase, type Db } from '../../db/client'
import { engineRuns, scans, sites } from '../../db/schema'
import { createSiteCipher } from '../../domain/headerCipher'
import { toSitePublic, toSiteSnapshot } from '../../domain/siteView'
import { createSite, type SiteServiceDeps } from '../siteService'
import { createDiscovery } from '../discoveryService'
import { ServiceError } from '../errors'
import {
  claimNextQueuedScan,
  createScan,
  latestScanSummary,
  listScans,
  recoverInterruptedScans,
} from '../scanService'
import { SiteInputSchema } from '#shared/schemas/site'

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
let t = 0
const now = () => new Date(2026 + t, 0, 1 + t++)
const id = () => `id-${++n}`

beforeEach(() => {
  n = 0
  t = 0
  db = openDatabase({ file: ':memory:', migrationsFolder })
  siteDeps = {
    db,
    cipher: createSiteCipher(randomBytes(32).toString('base64')),
    now: () => new Date('2026-01-01T00:00:00Z'),
    id: () => `site-${++n}`,
  }
})

function insertRawSite(overrides: Partial<typeof sites.$inferInsert> = {}) {
  const rowId = `raw-${++n}`
  db.insert(sites)
    .values({
      id: rowId,
      name: 'raw site',
      frontBaseUrl: 'https://x.example.com',
      apiBaseUrl: null,
      nucleiPaths: '/',
      openapiUrl: null,
      openapiJson: null,
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
      nucleiTags: [],
      openapiAllowedOrigins: [],
      headersEnc: null,
      headerNames: [],
      browserStorageNames: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    })
    .run()
  return rowId
}

/** Inserts a `queued` scan row directly, bypassing `createScan`'s own
 * validation, so tests can set up "an active scan already exists" for a
 * site state that `createScan` itself would refuse to create a scan for
 * (e.g. non-local-unconfirmed, or missing engine prerequisites). */
function insertActiveScan(siteId: string): void {
  const siteRow = db.select().from(sites).where(eq(sites.id, siteId)).get()
  if (!siteRow) throw new Error(`test fixture error: site ${siteId} not found`)
  db.insert(scans)
    .values({
      id: `active-${++n}`,
      siteId,
      status: 'queued',
      engines: ['nuclei'],
      siteSnapshot: toSiteSnapshot(toSitePublic(siteRow)),
      error: null,
      createdAt: now().toISOString(),
      startedAt: null,
      finishedAt: null,
    })
    .run()
}

/** Asserts `fn` throws a `ServiceError` with the given status/code, narrowing
 * via `instanceof` (no `as` cast) rather than duplicating a try/catch with a
 * cast in every call site. */
function expectServiceError(fn: () => unknown, statusCode: number, code: string): void {
  try {
    fn()
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e
    expect(e.statusCode).toBe(statusCode)
    expect(e.code).toBe(code)
    return
  }
  throw new Error(`expected a ServiceError(${statusCode}, ${code}) to be thrown`)
}

describe('createScan', () => {
  it('returns a queued scan with engines ordered by ENGINE_ORDER', () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei', 'zap-fe'])
    expect(scan.status).toBe('queued')
    expect(scan.engines).toEqual(['zap-fe', 'nuclei'])
    expect(scan.siteId).toBe(site.id)
    expect(scan.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0, info: 0 })
  })

  it('throws 404 SITE_NOT_FOUND for an unknown site', () => {
    expectServiceError(() => createScan(db, { now, id }, 'nope', ['nuclei']), 404, 'SITE_NOT_FOUND')
  })

  it('rejects a second scan while one is queued/running with 409 SCAN_ACTIVE', () => {
    const site = createSite(siteDeps, base)
    createScan(db, { now, id }, site.id, ['nuclei'])
    expectServiceError(() => createScan(db, { now, id }, site.id, ['nuclei']), 409, 'SCAN_ACTIVE')
  })

  it('rejects a scan while a discovery is queued/running with 409 DISCOVERY_ACTIVE', () => {
    const site = createSite(siteDeps, base)
    createDiscovery(db, { now, id }, site.id)
    expectServiceError(
      () => createScan(db, { now, id }, site.id, ['nuclei']),
      409,
      'DISCOVERY_ACTIVE',
    )
  })

  it('422 NON_LOCAL_UNCONFIRMED for a non-local site inserted without confirmation', () => {
    const siteId = insertRawSite()
    expectServiceError(
      () => createScan(db, { now, id }, siteId, ['nuclei']),
      422,
      'NON_LOCAL_UNCONFIRMED',
    )
  })

  it('422 ENGINE_PREREQ for zap-api without an openapi source', () => {
    const site = createSite(siteDeps, { ...base, openapiUrl: null })
    expectServiceError(
      () => createScan(db, { now, id }, site.id, ['zap-api']),
      422,
      'ENGINE_PREREQ',
    )
  })

  it('nuclei has no prerequisite (empty nucleiPaths falls back to the base URL)', () => {
    const site = createSite(siteDeps, { ...base, nucleiPaths: '' })
    const scan = createScan(db, { now, id }, site.id, ['nuclei'])
    expect(scan.engines).toEqual(['nuclei'])
  })

  it('zap-fe has no prerequisite', () => {
    const site = createSite(siteDeps, { ...base, nucleiPaths: '', openapiUrl: null })
    const scan = createScan(db, { now, id }, site.id, ['zap-fe'])
    expect(scan.engines).toEqual(['zap-fe'])
  })

  it('422 NON_LOCAL_UNCONFIRMED takes priority over an existing active scan', () => {
    const siteId = insertRawSite()
    insertActiveScan(siteId)
    expectServiceError(
      () => createScan(db, { now, id }, siteId, ['nuclei']),
      422,
      'NON_LOCAL_UNCONFIRMED',
    )
  })

  it('422 ENGINE_PREREQ takes priority over an existing active scan', () => {
    const site = createSite(siteDeps, { ...base, openapiUrl: null, openapiJson: null })
    insertActiveScan(site.id)
    expectServiceError(
      () => createScan(db, { now, id }, site.id, ['zap-api']),
      422,
      'ENGINE_PREREQ',
    )
  })
})

describe('claimNextQueuedScan', () => {
  it('claims the oldest queued scan, flips it to running, then returns null', () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei'])

    const claimed = claimNextQueuedScan(db, now)
    expect(claimed).toBe(scan.id)

    const row = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(row?.status).toBe('running')
    expect(row?.startedAt).not.toBeNull()

    expect(claimNextQueuedScan(db, now)).toBeNull()
  })

  it('claims the oldest of several queued scans', () => {
    const site1 = createSite(siteDeps, base)
    const site2 = createSite(siteDeps, { ...base, name: 'other' })
    const scan1 = createScan(db, { now, id }, site1.id, ['nuclei'])
    const scan2 = createScan(db, { now, id }, site2.id, ['nuclei'])
    expect(claimNextQueuedScan(db, now)).toBe(scan1.id)
    expect(claimNextQueuedScan(db, now)).toBe(scan2.id)
  })
})

describe('recoverInterruptedScans', () => {
  it('marks running scans and their running engine runs as failed', () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei'])
    claimNextQueuedScan(db, now)
    db.insert(engineRuns)
      .values({
        id: 'run-1',
        scanId: scan.id,
        engine: 'nuclei',
        status: 'running',
        startedAt: now().toISOString(),
        counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        meta: {},
        warnings: [],
      })
      .run()

    const recovered = recoverInterruptedScans(db, now)
    expect(recovered).toBe(1)

    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('failed')
    expect(scanRow?.error).toBe('server restarted while the scan was running')
    expect(scanRow?.finishedAt).not.toBeNull()

    const runRow = db.select().from(engineRuns).where(eq(engineRuns.id, 'run-1')).get()
    expect(runRow?.status).toBe('failed')
    expect(runRow?.error).toBe('server restarted while the scan was running')

    expect(recoverInterruptedScans(db, now)).toBe(0)
  })

  it('does not touch queued or done scans', () => {
    const site = createSite(siteDeps, base)
    createScan(db, { now, id }, site.id, ['nuclei'])
    expect(recoverInterruptedScans(db, now)).toBe(0)
  })
})

describe('listScans / latestScanSummary', () => {
  it('lists scans newest first and sums engine_runs counts', () => {
    const site = createSite(siteDeps, base)
    const scan1 = createScan(db, { now, id }, site.id, ['nuclei'])
    claimNextQueuedScan(db, now)
    db.update(scans)
      .set({ status: 'done', finishedAt: now().toISOString() })
      .where(eq(scans.id, scan1.id))
      .run()
    db.insert(engineRuns)
      .values({
        id: 'run-a',
        scanId: scan1.id,
        engine: 'nuclei',
        status: 'done',
        startedAt: now().toISOString(),
        finishedAt: now().toISOString(),
        counts: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
        meta: {},
        warnings: [],
      })
      .run()

    const scan2 = createScan(db, { now, id }, site.id, ['zap-fe'])

    const list = listScans(db, site.id)
    expect(list.map((s) => s.id)).toEqual([scan2.id, scan1.id])
    expect(list[1]?.counts).toEqual({ critical: 1, high: 2, medium: 0, low: 0, info: 0 })

    expect(latestScanSummary(db, site.id)?.id).toBe(scan2.id)
  })

  it('returns null when the site has no scans', () => {
    const site = createSite(siteDeps, base)
    expect(latestScanSummary(db, site.id)).toBeNull()
    expect(listScans(db, site.id)).toEqual([])
  })
})
