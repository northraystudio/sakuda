import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../client'
import { findings, scans, sites } from '../schema'
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))
function siteRow(id: string) {
  const now = new Date().toISOString()
  return {
    id,
    name: 'n',
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
    browserStorageNames: [],
    createdAt: now,
    updatedAt: now,
  }
}
describe('openDatabase', () => {
  it('migrates an in-memory database and enforces cascade', () => {
    const db = openDatabase({ file: ':memory:', migrationsFolder })
    db.insert(sites).values(siteRow('s1')).run()
    db.insert(scans)
      .values({
        id: 'sc1',
        siteId: 's1',
        status: 'queued',
        engines: ['nuclei'],
        // as never: fixture only; snapshot shape is irrelevant to the cascade test
        siteSnapshot: {} as never,
        createdAt: 'now',
      })
      .run()
    expect(db.select().from(scans).all()).toHaveLength(1)
    db.delete(sites).where(eq(sites.id, 's1')).run()
    expect(db.select().from(scans).all()).toHaveLength(0)
    expect(db.select().from(findings).all()).toHaveLength(0)
  })
})
