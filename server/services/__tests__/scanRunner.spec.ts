import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { openDatabase, type Db } from '../../db/client'
import { engineRuns, findings, scans, sites } from '../../db/schema'
import { parseEnv, type Env } from '../../config/env'
import { createSiteCipher, DecryptError } from '../../domain/headerCipher'
import { EngineError, type EngineOutput, type EngineRunner } from '../../engines/types'
import { logger } from '../../lib/logger'
import { createSite, type SiteServiceDeps } from '../siteService'
import { createScan } from '../scanService'
import { runScan, USER_CANCEL_REASON, type ScanRunnerDeps } from '../scanRunner'
import { SiteInputSchema } from '#shared/schemas/site'
import { emptyCounts } from '#shared/utils/severity'
import type { Engine } from '#shared/types/api'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const base = SiteInputSchema.parse({
  name: 'shop',
  frontBaseUrl: 'http://localhost:3001/',
  nucleiPaths: '/\n/api/products',
  openapiUrl: 'http://localhost:3001/openapi.json',
})

let db: Db
let env: Env
let siteDeps: SiteServiceDeps
let n = 0
const now = () => new Date('2026-02-01T00:00:00.000Z')
const id = () => `id-${++n}`
const tmpDataDirs: string[] = []

afterAll(async () => {
  await Promise.all(tmpDataDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function successOutput(overrides: Partial<EngineOutput> = {}): EngineOutput {
  return {
    findings: [],
    counts: emptyCounts(),
    meta: {},
    warnings: [],
    exitCode: 0,
    signal: null,
    ...overrides,
  }
}

function makeDeps(runners: Partial<Record<Engine, EngineRunner>>): ScanRunnerDeps {
  const full: Record<Engine, EngineRunner> = {
    nuclei: vi.fn(async () => successOutput()),
    'zap-api': vi.fn(async () => successOutput()),
    'zap-fe': vi.fn(async () => successOutput()),
    dalfox: vi.fn(async () => successOutput()),
    ...runners,
  }
  return { db, env, cipher: siteDeps.cipher, runners: full, logger, now, id }
}

beforeEach(() => {
  n = 0
  db = openDatabase({ file: ':memory:', migrationsFolder })
  const dataDir = mkdtempSync(join(tmpdir(), 'sakuda-scanrunner-'))
  tmpDataDirs.push(dataDir)
  env = parseEnv({
    SAKUDA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SAKUDA_DATA_DIR: dataDir,
  })
  siteDeps = { db, cipher: createSiteCipher(env.encryptionKey), now, id: randomUUID }
})

describe('runScan', () => {
  it('runs every engine, records counts/meta and findings with fingerprints', async () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei', 'zap-fe'])
    const nucleiOut = successOutput({
      counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      findings: [
        {
          engine: 'nuclei',
          ruleId: 'rule-1',
          name: 'Finding one',
          severity: 'critical',
          url: 'http://localhost:3001/a',
          method: null,
          param: null,
          evidence: null,
          description: null,
          solution: null,
          reference: null,
          raw: {},
        },
      ],
    })
    const deps = makeDeps({ nuclei: vi.fn(async () => nucleiOut) })

    await runScan(deps, scan.id, new AbortController().signal)

    const runs = db.select().from(engineRuns).where(eq(engineRuns.scanId, scan.id)).all()
    expect(runs).toHaveLength(2)
    const nucleiRun = runs.find((r) => r.engine === 'nuclei')
    expect(nucleiRun?.status).toBe('done')
    expect(nucleiRun?.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 0, info: 0 })

    const foundRows = db.select().from(findings).where(eq(findings.scanId, scan.id)).all()
    expect(foundRows).toHaveLength(1)
    expect(foundRows[0]?.fingerprint).toBe('nuclei|rule-1|http://localhost:3001/a|')
    expect(foundRows[0]?.engineRunId).toBe(nucleiRun?.id)

    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('done')
    expect(scanRow?.error).toBeNull()
    expect(scanRow?.finishedAt).not.toBeNull()
  })

  it('records a skipped engine run (not done/failed) and keeps the scan done', async () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['dalfox', 'nuclei'])
    const deps = makeDeps({
      dalfox: vi.fn(async () =>
        successOutput({ skipped: true, warnings: ['skipped: active checks off'], exitCode: null }),
      ),
    })

    await runScan(deps, scan.id, new AbortController().signal)

    const runs = db.select().from(engineRuns).where(eq(engineRuns.scanId, scan.id)).all()
    const dalfoxRun = runs.find((r) => r.engine === 'dalfox')
    const nucleiRun = runs.find((r) => r.engine === 'nuclei')
    expect(dalfoxRun?.status).toBe('skipped')
    expect(nucleiRun?.status).toBe('done')

    // A skipped run is neither success nor failure: the scan is done, not failed.
    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('done')
    expect(scanRow?.error).toBeNull()
  })

  it('reports failed + skipped counts when no engine succeeded but some were skipped', async () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei', 'dalfox'])
    const deps = makeDeps({
      nuclei: vi.fn(async () => {
        throw new EngineError('boom')
      }),
      dalfox: vi.fn(async () => successOutput({ skipped: true })),
    })

    await runScan(deps, scan.id, new AbortController().signal)

    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('failed')
    expect(scanRow?.error).toBe('1 engine run(s) failed, 1 skipped')
  })

  it('marks a scan done (not failed) when its only engine run was skipped', async () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['dalfox'])
    const deps = makeDeps({
      dalfox: vi.fn(async () => successOutput({ skipped: true })),
    })

    await runScan(deps, scan.id, new AbortController().signal)

    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('done')
    expect(scanRow?.error).toMatch(/skipped/i)
  })

  it('keeps running other engines when one fails, and records the runbook', async () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei', 'zap-fe'])
    const deps = makeDeps({
      nuclei: vi.fn(async () => {
        throw new EngineError('boom', 'check the runbook')
      }),
    })

    await runScan(deps, scan.id, new AbortController().signal)

    const runs = db.select().from(engineRuns).where(eq(engineRuns.scanId, scan.id)).all()
    const nucleiRun = runs.find((r) => r.engine === 'nuclei')
    const feRun = runs.find((r) => r.engine === 'zap-fe')
    expect(nucleiRun?.status).toBe('failed')
    expect(nucleiRun?.error).toBe('boom\nRunbook: check the runbook')
    expect(feRun?.status).toBe('done')

    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('done')
    expect(scanRow?.error).toBe('1 engine run(s) failed')
  })

  it('marks the scan failed when every engine run fails', async () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei', 'zap-fe'])
    const deps = makeDeps({
      nuclei: vi.fn(async () => {
        throw new Error('nuclei down')
      }),
      'zap-fe': vi.fn(async () => {
        throw new Error('zap down')
      }),
    })

    await runScan(deps, scan.id, new AbortController().signal)

    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('failed')
    expect(scanRow?.error).toBe('all 2 engine run(s) failed')
  })

  it('coerces a non-Error rejection to a string', async () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei'])
    const deps = makeDeps({
      nuclei: vi.fn(async () => {
        throw 'raw-string-rejection'
      }),
    })

    await runScan(deps, scan.id, new AbortController().signal)

    const run = db.select().from(engineRuns).where(eq(engineRuns.scanId, scan.id)).get()
    expect(run?.error).toBe('raw-string-rejection')
  })

  it('fails the scan immediately with "aborted" when the signal is already aborted', async () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei'])
    const deps = makeDeps({})
    const ac = new AbortController()
    ac.abort()

    await runScan(deps, scan.id, ac.signal)

    expect(deps.runners.nuclei).not.toHaveBeenCalled()
    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('failed')
    expect(scanRow?.error).toBe('aborted: server shutting down')
    const runs = db.select().from(engineRuns).where(eq(engineRuns.scanId, scan.id)).all()
    expect(runs).toHaveLength(0)
  })

  it('logs and returns without touching the db when the scan row is gone', async () => {
    const deps = makeDeps({})
    await expect(
      runScan(deps, 'missing-scan', new AbortController().signal),
    ).resolves.toBeUndefined()
  })

  it('marks the scan failed (never stuck running) when loading the site throws outside the engine loop', async () => {
    // headersEnc must be non-null so loadSiteWithHeaders actually calls
    // cipher.open (an empty header set short-circuits to `[]`).
    const site = createSite(siteDeps, { ...base, headers: [{ name: 'Cookie', value: 'a=b' }] })
    const scan = createScan(db, { now, id }, site.id, ['nuclei'])
    const deps = makeDeps({})
    // Simulate a rotated/corrupt encryption key: cipher.open throws
    // DecryptError from inside loadSiteWithHeaders, before the per-engine
    // try/catch in runScan is ever reached.
    deps.cipher = {
      ...siteDeps.cipher,
      headers: {
        seal: siteDeps.cipher.headers.seal,
        open: () => {
          throw new DecryptError('decryption failed (key/AAD mismatch or tampering)')
        },
      },
    }

    await runScan(deps, scan.id, new AbortController().signal)

    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('failed')
    expect(scanRow?.finishedAt).not.toBeNull()
    expect(scanRow?.error).toContain('scan runner crashed')
    expect(scanRow?.error).toContain('decryption failed')
    expect(deps.runners.nuclei).not.toHaveBeenCalled()
  })

  it('fails the scan when the site was deleted before the scan started', async () => {
    const site = createSite(siteDeps, base)
    const scan = createScan(db, { now, id }, site.id, ['nuclei'])
    // sites -> scans is ON DELETE CASCADE, so the site is removed with FK
    // enforcement briefly relaxed to leave the (already-created) scan row
    // orphaned, simulating a race between deletion and the job loop.
    db.run(sql`PRAGMA foreign_keys = OFF`)
    db.delete(sites).where(eq(sites.id, site.id)).run()
    db.run(sql`PRAGMA foreign_keys = ON`)
    const deps = makeDeps({})

    await runScan(deps, scan.id, new AbortController().signal)

    const scanRow = db.select().from(scans).where(eq(scans.id, scan.id)).get()
    expect(scanRow?.status).toBe('failed')
    expect(scanRow?.error).toBe('site was deleted before the scan started')
  })

  describe('auth check (#74)', () => {
    const finding = (engine: Engine) => ({
      engine,
      ruleId: 'r',
      name: 'n',
      severity: 'high' as const,
      url: 'http://localhost:3001/a',
      method: null,
      param: null,
      evidence: null,
      description: null,
      solution: null,
      reference: null,
      raw: {},
    })

    it('records a login lost mid-scan on the scan, keeping the scan running to the end', async () => {
      const site = createSite(siteDeps, { ...base, authCheckPath: '/me' })
      const scan = createScan(db, { now, id }, site.id, ['nuclei', 'zap-fe'])
      let status = 200
      const send = vi.fn(async () => status)
      const deps = {
        ...makeDeps({
          // The login breaks while nuclei runs; wait until the check sees it.
          nuclei: vi.fn(async () => {
            status = 401
            await vi.waitFor(
              () =>
                expect(
                  db.select().from(scans).where(eq(scans.id, scan.id)).get()?.authLost,
                ).not.toBeNull(),
              { timeout: 2000, interval: 5 },
            )
            return successOutput()
          }),
        }),
        authCheck: { send, intervalMs: 5 },
      }

      await runScan(deps, scan.id, new AbortController().signal)

      const row = db.select().from(scans).where(eq(scans.id, scan.id)).get()
      expect(row?.authLost).toEqual({
        detectedAt: '2026-02-01T00:00:00.000Z',
        path: '/me',
        status: 401,
      })
      expect(row?.status).toBe('done')
      expect(send).toHaveBeenCalledWith('http://localhost:3001/me', [], expect.any(AbortSignal))
    })

    it('never checks, and leaves authLost null, when the site has no check path', async () => {
      const site = createSite(siteDeps, base)
      const scan = createScan(db, { now, id }, site.id, ['nuclei'])
      const send = vi.fn(async () => 401)

      await runScan(
        { ...makeDeps({}), authCheck: { send, intervalMs: 5 } },
        scan.id,
        new AbortController().signal,
      )

      expect(send).not.toHaveBeenCalled()
      const row = db.select().from(scans).where(eq(scans.id, scan.id)).get()
      expect(row?.authLost).toBeNull()
      expect(row?.status).toBe('done')
    })

    it('ends a user-cancelled scan as failed "cancelled by user" and keeps earlier findings', async () => {
      const site = createSite(siteDeps, base)
      const scan = createScan(db, { now, id }, site.id, ['nuclei', 'zap-fe', 'zap-api'])
      const ac = new AbortController()
      const nuclei = vi.fn(async () => successOutput())
      const deps = makeDeps({
        // Order is zap-api → zap-fe → nuclei (ENGINE_ORDER).
        'zap-api': vi.fn(async () =>
          successOutput({
            findings: [finding('zap-api')],
            counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          }),
        ),
        // zap-fe is running when the user stops the scan.
        'zap-fe': vi.fn(
          ({ signal }) =>
            new Promise<EngineOutput>((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                reject(new EngineError('aborted: server shutting down')),
              )
              ac.abort(USER_CANCEL_REASON)
            }),
        ),
        nuclei,
      })

      await runScan(deps, scan.id, ac.signal)

      const row = db.select().from(scans).where(eq(scans.id, scan.id)).get()
      expect(row?.status).toBe('failed')
      expect(row?.error).toBe('cancelled by user')
      const runs = db.select().from(engineRuns).where(eq(engineRuns.scanId, scan.id)).all()
      expect(runs.find((r) => r.engine === 'zap-fe')?.error).toBe('cancelled by user')
      expect(runs.find((r) => r.engine === 'zap-api')?.status).toBe('done')
      expect(runs.some((r) => r.engine === 'nuclei')).toBe(false)
      expect(nuclei).not.toHaveBeenCalled()
      expect(db.select().from(findings).where(eq(findings.scanId, scan.id)).all()).toHaveLength(1)
    })
  })
})
