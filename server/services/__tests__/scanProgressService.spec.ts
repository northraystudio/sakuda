import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../db/client'
import { engineRuns, scans } from '../../db/schema'
import { createSiteCipher } from '../../domain/headerCipher'
import { createSite } from '../siteService'
import {
  getScanProgress,
  nucleiStageOf,
  parseNucleiProgress,
  parseZapStage,
  PROGRESS_TAIL_BYTES,
  readTail,
} from '../scanProgressService'
import { SiteInputSchema } from '#shared/schemas/site'
import type { Engine } from '#shared/types/api'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))

// A log that echoes a secret header and a target URL around the progress
// lines — none of it may come back out of the API.
const SECRET = 'Bearer sk-live-SECRET-TOKEN'
const nucleiStderr = [
  '[INF] Current nuclei version: v3.4.0',
  `[DBG] header Authorization: ${SECRET} for https://shop.example/admin?token=abc`,
  '{"duration":"0:00:05","errors":"0","hosts":"1","matched":"1","percent":"12","requests":"120","rps":"24","templates":"900","total":"1000"}',
  `[WRN] https://shop.example/admin?token=abc ${SECRET}`,
  '{"duration":"0:00:10","errors":"0","hosts":"1","matched":"3","percent":"47","requests":"470","rps":"47","templates":"900","total":"1000"}',
  '',
].join('\n')
const zapStdout = [
  'Job spider started',
  `Job spider requesting https://shop.example/?q=${SECRET}`,
  'Job spider finished, time taken: 00:00:12',
  'Job activeScan started',
  '',
].join('\n')

describe('progress parsers', () => {
  it('nuclei: the latest stats line wins; non-JSON lines are ignored', () => {
    expect(parseNucleiProgress(nucleiStderr)).toEqual({ percent: 47, matched: 3 })
  })

  it('nuclei: no stats yet / garbage values → null, out-of-range percent clamped', () => {
    expect(parseNucleiProgress('[INF] loading templates\n')).toEqual({
      percent: null,
      matched: null,
    })
    expect(parseNucleiProgress('{"requests":"1","percent":"250","matched":"-1"}')).toEqual({
      percent: 100,
      matched: null,
    })
    expect(parseNucleiProgress('{"requests":"1","percent":"abc"}')).toEqual({
      percent: null,
      matched: null,
    })
  })

  it('nuclei: stage comes from the phase log name only', () => {
    expect(nucleiStageOf('dast-stderr.log')).toBe('dast')
    expect(nucleiStageOf('exposure-stderr.log')).toBe('exposure')
    expect(nucleiStageOf('stderr.log')).toBe('signature')
    expect(nucleiStageOf('openapi-stderr-2.log')).toBe('openapi')
    expect(nucleiStageOf('stdout.log')).toBeNull()
    expect(nucleiStageOf('findings.jsonl')).toBeNull()
  })

  it('zap: the most recently started job, allowlisted names only', () => {
    expect(parseZapStage(zapStdout)).toBe('activeScan')
    expect(parseZapStage('Job my-secret-job started\n')).toBeNull()
    expect(parseZapStage('ZAP is starting\n')).toBeNull()
  })
})

describe('readTail', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sakuda-progress-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('missing file → null', async () => {
    expect(await readTail(join(dir, 'nope.log'))).toBeNull()
  })

  it('reads at most PROGRESS_TAIL_BYTES from the end', async () => {
    const path = join(dir, 'big.log')
    await writeFile(path, 'x'.repeat(PROGRESS_TAIL_BYTES * 2) + 'END')
    const tail = await readTail(path)
    expect(tail).toHaveLength(PROGRESS_TAIL_BYTES)
    expect(tail?.endsWith('END')).toBe(true)
  })
})

describe('getScanProgress', () => {
  let db: Db
  let scansDir: string
  let siteId: string

  beforeEach(async () => {
    scansDir = await mkdtemp(join(tmpdir(), 'sakuda-scans-'))
    db = openDatabase({ file: ':memory:', migrationsFolder })
    const site = createSite(
      {
        db,
        cipher: createSiteCipher(randomBytes(32).toString('base64')),
        now: () => new Date('2026-01-01T00:00:00Z'),
        id: () => 'site-1',
      },
      SiteInputSchema.parse({
        name: 'shop',
        frontBaseUrl: 'http://localhost:3001/',
        nucleiPaths: '/',
      }),
    )
    siteId = site.id
  })
  afterEach(async () => {
    await rm(scansDir, { recursive: true, force: true })
  })

  function insertScan(status: 'queued' | 'running' | 'done' | 'failed') {
    db.insert(scans)
      .values({
        id: 'scan-1',
        siteId,
        status,
        engines: ['nuclei', 'zap-fe', 'dalfox'],
        siteSnapshot: {
          name: 'shop',
          frontBaseUrl: 'http://localhost:3001/',
          apiBaseUrl: null,
          nucleiPaths: '/',
          openapiUrl: null,
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
        createdAt: '2026-01-01T00:00:00Z',
        startedAt: status === 'queued' ? null : '2026-01-01T00:00:00Z',
        finishedAt: null,
      })
      .run()
  }

  function insertRun(id: string, engine: Engine, status: 'running' | 'done') {
    db.insert(engineRuns)
      .values({
        id,
        scanId: 'scan-1',
        engine,
        status,
        startedAt: '2026-01-01T00:00:00Z',
        counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        meta: {},
        warnings: [],
      })
      .run()
  }

  async function writeWork(engine: Engine, name: string, body: string, mtimeSec?: number) {
    const dir = join(scansDir, 'scan-1', engine)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), body)
    if (mtimeSec !== undefined) await utimes(join(dir, name), mtimeSec, mtimeSec)
  }

  it('unknown scan → null', async () => {
    expect(await getScanProgress(db, scansDir, 'nope')).toBeNull()
  })

  it('queued or finished → no progress', async () => {
    insertScan('queued')
    expect(await getScanProgress(db, scansDir, 'scan-1')).toEqual({
      scanId: 'scan-1',
      status: 'queued',
      progress: null,
    })
  })

  it('running nuclei: newest phase log, numbers only — no log text leaks', async () => {
    insertScan('running')
    insertRun('r1', 'nuclei', 'running')
    await writeWork(
      'nuclei',
      'dast-stderr.log',
      '{"requests":"9","percent":"100","matched":"9"}',
      1000,
    )
    await writeWork('nuclei', 'stderr.log', nucleiStderr, 2000)
    const res = await getScanProgress(db, scansDir, 'scan-1')
    expect(res?.progress).toEqual({ engine: 'nuclei', percent: 47, matched: 3, stage: 'signature' })
    const json = JSON.stringify(res)
    expect(json).not.toContain('SECRET')
    expect(json).not.toContain('shop.example')
  })

  it('running zap-fe: current job; secrets in the log stay out', async () => {
    insertScan('running')
    insertRun('r0', 'nuclei', 'done')
    insertRun('r1', 'zap-fe', 'running')
    await writeWork('zap-fe', 'stdout.log', zapStdout)
    const res = await getScanProgress(db, scansDir, 'scan-1')
    expect(res?.progress).toEqual({
      engine: 'zap-fe',
      percent: null,
      matched: null,
      stage: 'activeScan',
    })
    expect(JSON.stringify(res)).not.toContain('SECRET')
  })

  it('running engine with no output yet / dalfox → all unknown, no error', async () => {
    insertScan('running')
    insertRun('r1', 'dalfox', 'running')
    expect((await getScanProgress(db, scansDir, 'scan-1'))?.progress).toEqual({
      engine: 'dalfox',
      percent: null,
      matched: null,
      stage: null,
    })
  })

  it('running nuclei before its work dir exists → unknown', async () => {
    insertScan('running')
    insertRun('r1', 'nuclei', 'running')
    expect((await getScanProgress(db, scansDir, 'scan-1'))?.progress?.stage).toBeNull()
  })
})
