import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase, type Db } from '../../db/client'
import { scans } from '../../db/schema'
import { createSiteCipher } from '../../domain/headerCipher'
import { createSite } from '../siteService'
import { createScan } from '../scanService'
import { cancelRunningScan } from '../scanCancel'
import { ServiceError } from '../errors'
import { SiteInputSchema } from '#shared/schemas/site'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const now = () => new Date('2026-02-01T00:00:00.000Z')

let db: Db
let scanId: string

beforeEach(() => {
  db = openDatabase({ file: ':memory:', migrationsFolder })
  const cipher = createSiteCipher(randomBytes(32).toString('base64'))
  const site = createSite(
    { db, cipher, now, id: randomUUID },
    SiteInputSchema.parse({
      name: 'shop',
      frontBaseUrl: 'http://localhost:3001',
      nucleiPaths: '/',
    }),
  )
  scanId = createScan(db, { now, id: randomUUID }, site.id, ['nuclei']).id
})

function setStatus(status: 'queued' | 'running' | 'done') {
  db.update(scans).set({ status }).where(eq(scans.id, scanId)).run()
}

function codeOf(fn: () => void): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof ServiceError ? `${e.statusCode} ${e.code}` : 'other'
  }
}

describe('cancelRunningScan', () => {
  it('signals the job loop for a running scan', () => {
    setStatus('running')
    const loop = { cancelScan: vi.fn(() => true) }
    cancelRunningScan(db, loop, scanId)
    expect(loop.cancelScan).toHaveBeenCalledWith(scanId)
  })

  it('is 404 for an unknown scan', () => {
    expect(codeOf(() => cancelRunningScan(db, { cancelScan: () => true }, 'nope'))).toBe(
      '404 SCAN_NOT_FOUND',
    )
  })

  it.each(['queued', 'done'] as const)('is 409 for a %s scan', (status) => {
    setStatus(status)
    const loop = { cancelScan: vi.fn(() => true) }
    expect(codeOf(() => cancelRunningScan(db, loop, scanId))).toBe('409 SCAN_NOT_RUNNING')
    expect(loop.cancelScan).not.toHaveBeenCalled()
  })

  it('is 409 when the job runner is off or runs another scan', () => {
    setStatus('running')
    expect(codeOf(() => cancelRunningScan(db, null, scanId))).toBe('409 SCAN_NOT_RUNNING')
    expect(codeOf(() => cancelRunningScan(db, { cancelScan: () => false }, scanId))).toBe(
      '409 SCAN_NOT_RUNNING',
    )
  })
})
