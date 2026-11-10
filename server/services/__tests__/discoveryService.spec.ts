import { beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase, type Db } from '../../db/client'
import { discoveries, scans, sites } from '../../db/schema'
import { createSiteCipher } from '../../domain/headerCipher'
import { createSite, type SiteServiceDeps } from '../siteService'
import { createScan } from '../scanService'
import { ServiceError } from '../errors'
import {
  claimNextQueuedDiscovery,
  createDiscovery,
  getDiscovery,
  listDiscoveries,
  recoverInterruptedDiscoveries,
} from '../discoveryService'
import { SiteInputSchema } from '#shared/schemas/site'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const base = SiteInputSchema.parse({ name: 'shop', frontBaseUrl: 'http://localhost:3001/' })

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

describe('createDiscovery', () => {
  it('queues a discovery with no URLs yet', () => {
    const site = createSite(siteDeps, base)
    const d = createDiscovery(db, { now, id }, site.id)
    expect(d).toMatchObject({ siteId: site.id, status: 'queued', urlCount: 0, error: null })
    expect(getDiscovery(db, d.id)).toMatchObject({ id: d.id, urls: [], meta: {}, warnings: [] })
  })

  it('throws 404 for an unknown site', () => {
    expectServiceError(() => createDiscovery(db, { now, id }, 'nope'), 404, 'SITE_NOT_FOUND')
  })

  it('rejects a second discovery while one is active (409 DISCOVERY_ACTIVE)', () => {
    const site = createSite(siteDeps, base)
    createDiscovery(db, { now, id }, site.id)
    expectServiceError(() => createDiscovery(db, { now, id }, site.id), 409, 'DISCOVERY_ACTIVE')
  })

  it('rejects a discovery while a scan is active, and a scan while a discovery is active', () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei'])
    expectServiceError(() => createDiscovery(db, { now, id }, site.id), 409, 'SCAN_ACTIVE')

    db.update(scans).set({ status: 'done' }).where(eq(scans.id, scan.id)).run()
    createDiscovery(db, { now, id }, site.id)
    expectServiceError(
      () => createScan(db, { now, id }, site.id, ['nuclei']),
      409,
      'DISCOVERY_ACTIVE',
    )
  })

  it('422 NON_LOCAL_UNCONFIRMED for a non-local site inserted without confirmation', () => {
    db.insert(sites)
      .values({
        id: 'raw-1',
        name: 'raw site',
        frontBaseUrl: 'https://x.example.com',
        apiBaseUrl: null,
        nucleiPaths: '',
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
      })
      .run()
    expectServiceError(
      () => createDiscovery(db, { now, id }, 'raw-1'),
      422,
      'NON_LOCAL_UNCONFIRMED',
    )
  })
})

describe('claimNextQueuedDiscovery / recoverInterruptedDiscoveries', () => {
  it('claims the oldest queued discovery, flips it to running, then returns null', () => {
    const site = createSite(siteDeps, base)
    const d = createDiscovery(db, { now, id }, site.id)
    expect(claimNextQueuedDiscovery(db, now)).toBe(d.id)
    expect(getDiscovery(db, d.id)?.status).toBe('running')
    expect(getDiscovery(db, d.id)?.startedAt).not.toBeNull()
    expect(claimNextQueuedDiscovery(db, now)).toBeNull()
  })

  it('marks running discoveries failed on restart, leaving queued/done alone', () => {
    const site1 = createSite(siteDeps, base)
    const site2 = createSite(siteDeps, { ...base, name: 'other' })
    const running = createDiscovery(db, { now, id }, site1.id)
    claimNextQueuedDiscovery(db, now)
    const queued = createDiscovery(db, { now, id }, site2.id)

    expect(recoverInterruptedDiscoveries(db, now)).toBe(1)
    expect(getDiscovery(db, running.id)).toMatchObject({
      status: 'failed',
      error: 'server restarted while the discovery was running',
    })
    expect(getDiscovery(db, running.id)?.finishedAt).not.toBeNull()
    expect(getDiscovery(db, queued.id)?.status).toBe('queued')
    expect(recoverInterruptedDiscoveries(db, now)).toBe(0)
  })
})

describe('listDiscoveries / getDiscovery', () => {
  it('lists newest first with urlCount, and getDiscovery returns the full detail', () => {
    const site = createSite(siteDeps, base)
    const d1 = createDiscovery(db, { now, id }, site.id)
    db.update(discoveries)
      .set({
        status: 'done',
        urls: [
          { url: 'http://localhost:3001/a', method: 'GET', statusCode: 200, source: 'spider' },
        ],
        meta: { urlCount: 1 },
      })
      .where(eq(discoveries.id, d1.id))
      .run()
    const d2 = createDiscovery(db, { now, id }, site.id)

    const list = listDiscoveries(db, site.id)
    expect(list.map((d) => d.id)).toEqual([d2.id, d1.id])
    expect(list[1]?.urlCount).toBe(1)
    expect(getDiscovery(db, d1.id)?.urls[0]?.url).toBe('http://localhost:3001/a')
    expect(getDiscovery(db, 'missing')).toBeNull()
  })

  it('honours the limit', () => {
    const site = createSite(siteDeps, base)
    for (let i = 0; i < 3; i++) {
      const d = createDiscovery(db, { now, id }, site.id)
      db.update(discoveries).set({ status: 'done' }).where(eq(discoveries.id, d.id)).run()
    }
    expect(listDiscoveries(db, site.id, 2)).toHaveLength(2)
  })
})
