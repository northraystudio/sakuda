import { beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { openDatabase, type Db } from '../../db/client'
import { discoveries, scans, sites } from '../../db/schema'
import { listActiveJobs } from '../activeJobs'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
let db: Db

function site(id: string, name: string) {
  db.insert(sites)
    .values({
      id,
      name,
      frontBaseUrl: 'http://localhost:3000',
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
      browserStorageEnc: null,
      browserStorageNames: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    .run()
}

function scan(
  id: string,
  siteId: string,
  status: 'queued' | 'running' | 'done',
  createdAt: string,
) {
  db.insert(scans)
    .values({
      id,
      siteId,
      status,
      engines: ['nuclei'],
      siteSnapshot: {} as never,
      error: null,
      createdAt,
      startedAt: status === 'running' ? '2026-01-02T00:00:00.000Z' : null,
      finishedAt: null,
    })
    .run()
}

function discovery(
  id: string,
  siteId: string,
  status: 'queued' | 'running' | 'done',
  createdAt: string,
) {
  db.insert(discoveries)
    .values({
      id,
      siteId,
      status,
      urls: [],
      meta: {},
      warnings: [],
      error: null,
      createdAt,
      startedAt: status === 'running' ? '2026-01-02T00:00:00.000Z' : null,
      finishedAt: null,
    })
    .run()
}

beforeEach(() => {
  db = openDatabase({ file: ':memory:', migrationsFolder })
  site('s1', 'Alpha')
  site('s2', 'Beta')
})

describe('listActiveJobs', () => {
  it('orders by the job loop claim order: running, then queued scans oldest-first, then queued discoveries oldest-first', () => {
    // insertion order deliberately scrambled
    discovery('d-queued-new', 's1', 'queued', '2026-01-01T10:00:00.000Z')
    scan('sc-queued-new', 's2', 'queued', '2026-01-01T09:00:00.000Z')
    discovery('d-running', 's1', 'running', '2026-01-01T05:00:00.000Z')
    scan('sc-queued-old', 's1', 'queued', '2026-01-01T08:00:00.000Z')
    discovery('d-queued-old', 's2', 'queued', '2026-01-01T07:00:00.000Z')

    expect(listActiveJobs(db).map((j) => j.id)).toEqual([
      'd-running',
      'sc-queued-old',
      'sc-queued-new',
      'd-queued-old',
      'd-queued-new',
    ])
  })

  it('excludes done and failed jobs', () => {
    scan('sc-done', 's1', 'done', '2026-01-01T01:00:00.000Z')
    discovery('d-queued', 's1', 'queued', '2026-01-01T02:00:00.000Z')
    expect(listActiveJobs(db).map((j) => j.id)).toEqual(['d-queued'])
  })

  it('carries kind, status, site name, timestamps, and engines (scans only)', () => {
    scan('sc', 's1', 'running', '2026-01-01T03:00:00.000Z')
    discovery('d', 's2', 'queued', '2026-01-01T04:00:00.000Z')
    const [job, disc] = listActiveJobs(db)
    expect(job).toMatchObject({
      kind: 'scan',
      status: 'running',
      id: 'sc',
      siteId: 's1',
      siteName: 'Alpha',
      engines: ['nuclei'],
    })
    expect(job?.startedAt).not.toBeNull()
    expect(disc).toMatchObject({ kind: 'discovery', status: 'queued', siteName: 'Beta' })
    expect(disc?.engines).toBeUndefined()
  })

  it('returns [] when nothing is active', () => {
    expect(listActiveJobs(db)).toEqual([])
  })
})
