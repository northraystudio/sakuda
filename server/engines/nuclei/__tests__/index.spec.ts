import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseEnv, type Env } from '../../../config/env'
import type { SiteWithHeaders } from '../../../services/siteService'
import { EngineError } from '../../types'
import { runNuclei } from '../index'

// Fake nuclei binary: reads the -o output path and -l targets file from
// argv, writes one JSONL "high" finding whose matched-at uses the first
// target's host, prints a nuclei-shaped stats line to stdout, exits 0.
const FAKE_SUCCESS = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const outFile = args[args.indexOf('-o') + 1]
const targetsFile = args[args.indexOf('-l') + 1]
let host = 'localhost'
try {
  const first = fs.readFileSync(targetsFile, 'utf8').trim().split('\\n')[0]
  host = new URL(first).host
} catch {}
const finding = {
  'template-id': 'fake-high',
  info: { name: 'Fake High', severity: 'high' },
  host,
  'matched-at': 'http://' + host + '/a',
}
// The priority exposure pass (#3) is a distinct nuclei run over a small tag
// set; the fake finds nothing there so finding-count assertions stay about the
// full signature / DAST passes.
fs.writeFileSync(outFile, outFile.includes('exposure') ? '' : JSON.stringify(finding) + '\\n')
console.log(JSON.stringify({ requests: '10', errors: '0' }))
process.exit(0)
`

const FAKE_FAILURE = `#!/usr/bin/env node
process.exit(2)
`

function writeFakeBin(dir: string, name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  chmodSync(p, 0o755)
  return p
}

const key = randomBytes(32).toString('base64')

// The probe ahead of nuclei (#91) must not spawn a real httpx from PATH in a
// unit test. Every run here gets this fake, which reports 200 for each input
// (so the run's warnings stay exactly what nuclei produced); the #91 tests
// below swap in their own fakes and a missing binary.
const FAKE_HTTPX_OK = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
for (const input of fs.readFileSync(args[args.indexOf('-l') + 1], 'utf8').trim().split('\\n'))
  console.log(JSON.stringify({ input, status_code: 200, failed: false }))
`
const FAKE_HTTPX_ENV = {
  SAKUDA_HTTPX_BIN: writeFakeBin(
    mkdtempSync(join(tmpdir(), 'sakuda-httpx-ok-')),
    'fake-httpx-ok.js',
    FAKE_HTTPX_OK,
  ),
}
const NO_HTTPX = { SAKUDA_HTTPX_BIN: '/nonexistent/sakuda-test/httpx' }

function baseSite(overrides: Partial<SiteWithHeaders> = {}): SiteWithHeaders {
  return {
    id: 'site-1',
    name: 'shop',
    frontBaseUrl: 'http://localhost:3001',
    apiBaseUrl: null,
    nucleiPaths: '/a\n/b',
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
    headerNames: [],
    browserStorageNames: [],
    requiresConfirmation: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    headers: [],
    browserStorage: [],
    ...overrides,
  }
}

describe('runNuclei', () => {
  let tmp: string
  const logger = pino({ level: 'silent' })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sakuda-nuclei-'))
  })

  it('runs the fake binary and normalizes its output', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_SUCCESS)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const out = await runNuclei({
      scanId: 'scan-1',
      engine: 'nuclei',
      site: baseSite(),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(out.findings).toHaveLength(1)
    expect(out.counts.high).toBe(1)
    expect(out.meta.urlCount).toBe(2)
    // the budget the runner enforced is recorded for the page (#84)
    expect(out.meta.timeBudget).toMatchObject({ totalMinutes: expect.any(Number) })
    expect(readFileSync(join(workDir, 'targets.txt'), 'utf8')).toBe(
      'http://localhost:3001/a\nhttp://localhost:3001/b\n',
    )
    expect(out.findings[0]!.url).toBe('http://localhost:3001/a')
  })

  it('rewrites loopback host in targets and restores it in finding urls', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_SUCCESS)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_LOCALHOST_ALIAS: 'host.docker.internal',
    })
    const workDir = join(tmp, 'work')
    const out = await runNuclei({
      scanId: 'scan-1',
      engine: 'nuclei',
      site: baseSite(),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(readFileSync(join(workDir, 'targets.txt'), 'utf8')).toContain('host.docker.internal')
    expect(out.findings[0]!.url).toContain('localhost')
    expect(out.findings[0]!.url).not.toContain('host.docker.internal')
  })

  it('throws EngineError when the binary exits non-zero with no output', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei-fail.js', FAKE_FAILURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    await expect(
      runNuclei({
        scanId: 'scan-2',
        engine: 'nuclei',
        site: baseSite(),
        workDir,
        env,
        logger,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(EngineError)
  })

  it('throws a clean "aborted" EngineError (not a confusing exit-code diagnosis) when the signal is already aborted (I6)', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_SUCCESS)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const ac = new AbortController()
    ac.abort()
    await expect(
      runNuclei({
        scanId: 'scan-4',
        engine: 'nuclei',
        site: baseSite(),
        workDir,
        env,
        logger,
        signal: ac.signal,
      }),
    ).rejects.toThrow('nuclei aborted: server shutting down')
  })

  it('throws EngineError with no target URLs, before spawning the binary', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_SUCCESS)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    await expect(
      runNuclei({
        scanId: 'scan-3',
        engine: 'nuclei',
        // every configured path excluded → nothing left to scan
        site: baseSite({ nucleiPaths: '/only', excludePaths: '/only' }),
        workDir,
        env,
        logger,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/no GET target URLs/)
    expect(existsSync(join(workDir, 'targets.txt'))).toBe(false)
  })

  it('replays only GET saved lines, skips non-GET into meta.skippedMethods, and never writes a non-GET target', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_SUCCESS)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'skip')
    const out = await runNuclei({
      scanId: 'scan-skip',
      engine: 'nuclei',
      // the two `POST /api/x` lines collapse (dedupe is method+base+url)
      site: baseSite({ nucleiPaths: '/get-one\nPOST /api/x\nPOST /api/x\nDELETE /y\nHEAD /z' }),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })
    expect(out.meta.skippedMethods).toEqual({ POST: 1, DELETE: 1, HEAD: 1 })
    expect(out.meta.urlCount).toBe(1)
    const targets = readFileSync(join(workDir, 'targets.txt'), 'utf8')
    expect(targets).toContain('/get-one')
    expect(targets).not.toContain('/api/x')
    expect(targets).not.toContain('/y')
    expect(targets).not.toContain('/z')
  })

  it('writes one target when a front line and an api: line resolve to the same URL', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_SUCCESS)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'same-url')
    const out = await runNuclei({
      scanId: 'scan-same-url',
      engine: 'nuclei',
      // apiBaseUrl is the front base plus `/api`, so `/api/x` and `api:/x`
      // are the same request; the expansion keeps both (identity is
      // method+base+url) and nuclei must not replay the URL twice
      site: baseSite({
        apiBaseUrl: 'http://localhost:3001/api',
        nucleiPaths: '/api/x\napi:/x\nPOST /api/y\nPOST api:/y',
      }),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })
    expect(readFileSync(join(workDir, 'targets.txt'), 'utf8')).toBe('http://localhost:3001/api/x\n')
    expect(out.meta.urlCount).toBe(1)
    expect(out.meta.skippedMethods).toEqual({ POST: 1 })
  })

  it('under active checks, fuzzes a non-GET-with-query via a generated OpenAPI phase, skips a queryless one, and deletes the secret docs', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_SUCCESS)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'active')
    const out = await runNuclei({
      scanId: 'scan-openapi',
      engine: 'nuclei',
      site: baseSite({
        allowMutatingRequests: true,
        nucleiPaths: '/get?q=\nPOST /api/x?p=\nPOST /bodyless',
      }),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })
    // POST /api/x?p= has a query surface → one generated doc, run once.
    expect(out.meta.openapiDocCount).toBe(1)
    expect(out.meta.openapiDocsRun).toBe(1)
    // POST /bodyless has no query and gets no invented body → skipped-with-reason.
    expect(out.meta.skippedNoFuzzSeed).toEqual({ POST: 1 })
    // active run: nothing is in the "not attempted at all" bucket.
    expect(out.meta.skippedMethods).toBeUndefined()
    // every phase produced a finding via the fake binary: signature + GET DAST + OpenAPI
    expect(out.counts.high).toBe(3)
    // the GET phase's transient targets file seeded the empty query
    expect(readFileSync(join(workDir, 'targets.txt'), 'utf8')).toContain('/get?q=1')
    // the generated OpenAPI doc and its outputs are removed after the run
    expect(existsSync(join(workDir, 'openapi-0.json'))).toBe(false)
    expect(existsSync(join(workDir, 'openapi-findings-0.jsonl'))).toBe(false)
  })

  it('under active checks with only a queryless non-GET target, there is nothing to scan', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_SUCCESS)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
    })
    await expect(
      runNuclei({
        scanId: 'scan-empty',
        engine: 'nuclei',
        site: baseSite({ allowMutatingRequests: true, nucleiPaths: 'POST /bodyless' }),
        workDir: join(tmp, 'nothing'),
        env,
        logger,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/nothing to scan/)
  })
})

// Records argv next to the output file — one file per phase, named after
// the phase's output (`argv-findings.jsonl.json`, `argv-dast-findings.jsonl.json`)
// so a test can assert on the exact flags of each nuclei run — then behaves
// like FAKE_SUCCESS without findings.
const FAKE_RECORD_ARGS = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const outFile = args[args.indexOf('-o') + 1]
// what the -config headers file held while this phase ran (it is removed after the run)
if (args.includes('-config'))
  fs.copyFileSync(args[args.indexOf('-config') + 1], path.join(path.dirname(outFile), 'seen-headers-' + path.basename(outFile) + '.json'))
fs.writeFileSync(path.join(path.dirname(outFile), 'argv-' + path.basename(outFile) + '.json'), JSON.stringify(args))
fs.appendFileSync(path.join(path.dirname(outFile), 'order.log'), path.basename(outFile) + '\\n')
fs.writeFileSync(outFile, '')
console.log(JSON.stringify({ requests: '10', errors: '0' }))
process.exit(0)
`

// Like FAKE_SUCCESS (one "high" finding per run) but exits 2 with no output
// when invoked as the GET DAST phase (`-dast` without `-im`).
const FAKE_DAST_PHASE_FAILS = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const outFile = args[args.indexOf('-o') + 1]
if (args.includes('-dast') && !args.includes('-im')) process.exit(2)
const finding = {
  'template-id': 'fake-high',
  info: { name: 'Fake High', severity: 'high' },
  host: 'localhost:3001',
  'matched-at': 'http://localhost:3001/a',
}
fs.writeFileSync(outFile, outFile.includes('exposure') ? '' : JSON.stringify(finding) + '\\n')
console.log(JSON.stringify({ requests: '10', errors: '0' }))
process.exit(0)
`

// The GET DAST phase exits 2 with no output; every other run completes
// cleanly with no findings (an "empty" phase, not a failed one).
const FAKE_DAST_FAILS_OTHERS_EMPTY = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const outFile = args[args.indexOf('-o') + 1]
if (args.includes('-dast') && !args.includes('-im')) process.exit(2)
fs.writeFileSync(outFile, '')
console.log(JSON.stringify({ requests: '10', errors: '0' }))
process.exit(0)
`

describe('runNuclei active injection checks (allowMutatingRequests)', () => {
  let tmp: string
  const logger = pino({ level: 'silent' })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sakuda-nuclei-dast-'))
  })

  async function run(
    site: SiteWithHeaders,
    fake = FAKE_RECORD_ARGS,
    extraEnv: Record<string, string> = {},
  ) {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', fake)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_NUCLEI_TEMPLATES: '/tpl/http',
      SAKUDA_NUCLEI_DAST_TEMPLATES: '/tpl/dast',
      ...extraEnv,
    })
    const workDir = join(tmp, 'work')
    const out = await runNuclei({
      scanId: 'scan-dast',
      engine: 'nuclei',
      site,
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })
    // as: the argv files are written by the fake binary above as JSON string[]
    const argvOf = (output: string): string[] | null => {
      const p = join(workDir, `argv-${output}.json`)
      return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as string[]) : null
    }
    // signature phase = `findings.jsonl`; GET DAST phase = `dast-findings.jsonl`
    const orderPath = join(workDir, 'order.log')
    const order = existsSync(orderPath) ? readFileSync(orderPath, 'utf8').trim().split('\n') : []
    return { out, argv: argvOf('findings.jsonl')!, dastArgv: argvOf('dast-findings.jsonl'), order }
  }

  it('runs the signature phase only, never -dast, when the site is not opted in', async () => {
    const { out, argv, dastArgv } = await run(baseSite({ nucleiPaths: '/search?q=' }))
    expect(argv).not.toContain('-dast')
    expect(argv).not.toContain('/tpl/dast')
    expect(dastArgv).toBeNull()
    expect(out.meta.activeScan).toBe(false)
    expect(out.meta.dastTemplatesDir).toBeUndefined()
    expect(out.meta.signaturePhase).toBe('empty')
    expect(out.meta.dastPhase).toBe('skipped')
    expect(out.warnings).toEqual([])
  })

  it('seeds empty query values in the targets file only when opted in', async () => {
    const on = await run(baseSite({ allowMutatingRequests: true, nucleiPaths: '/search?q=' }))
    expect(readFileSync(join(tmp, 'work', 'targets.txt'), 'utf8')).toContain('/search?q=1')

    const off = await run(baseSite({ nucleiPaths: '/search?q=' }))
    expect(readFileSync(join(tmp, 'work', 'targets.txt'), 'utf8')).toContain('/search?q=\n')
    expect(readFileSync(join(tmp, 'work', 'targets.txt'), 'utf8')).not.toContain('/search?q=1')
    void on
    void off
  })

  it('drops hash-route lines from the targets file (fragments never reach the server)', async () => {
    await run(baseSite({ nucleiPaths: '/plain\n/#/search?q=\n/#/track?id=' }))
    const targets = readFileSync(join(tmp, 'work', 'targets.txt'), 'utf8')
    expect(targets).toBe('http://localhost:3001/plain\n')
    expect(targets).not.toContain('#')
  })

  it('under active checks runs two GET phases: DAST (dast tree, -dast) first, then signature (http tree, no -dast)', async () => {
    const { out, argv, dastArgv, order } = await run(
      baseSite({ allowMutatingRequests: true, nucleiPaths: '/search?q=\n/plain' }),
    )
    // DAST runs first so the short phase never queues behind the long
    // signature phase inside the shared engine budget (#82); the priority
    // exposure pass (#3) runs between DAST and the full signature tree.
    expect(order).toEqual(['dast-findings.jsonl', 'exposure-findings.jsonl', 'findings.jsonl'])
    // signature phase: the http tree only, and never -dast (it would drop every signature template)
    expect(argv).not.toContain('-dast')
    expect(argv.filter((a) => a === '-t')).toHaveLength(1)
    expect(argv[argv.indexOf('-t') + 1]).toBe('/tpl/http')
    // DAST phase: the dast tree only, with -dast, against the same targets file
    expect(dastArgv).not.toBeNull()
    expect(dastArgv).toContain('-dast')
    expect(dastArgv!.filter((a) => a === '-t')).toHaveLength(1)
    expect(dastArgv![dastArgv!.indexOf('-t') + 1]).toBe('/tpl/dast')
    expect(dastArgv![dastArgv!.indexOf('-l') + 1]).toBe(argv[argv.indexOf('-l') + 1])
    expect(out.meta.activeScan).toBe(true)
    expect(out.meta.dastTemplatesDir).toBe('/tpl/dast')
    expect(out.meta.signaturePhase).toBe('empty')
    expect(out.meta.dastPhase).toBe('empty')
    expect(out.meta.parameterizedUrlCount).toBe(1)
    expect(out.warnings).toEqual([])
  })

  it('runs a priority exposure pass over the exposure/config/misconfig tags before the full tree (#3)', async () => {
    const { out, order } = await run(baseSite({ nucleiPaths: '/a' }))
    const exposureArgv = JSON.parse(
      readFileSync(join(tmp, 'work', 'argv-exposure-findings.jsonl.json'), 'utf8'),
    ) as string[]
    // the exposure pass restricts -tags to the high-signal set and loads the
    // http (signature) tree, never -dast
    expect(exposureArgv[exposureArgv.indexOf('-tags') + 1]).toBe('exposure,config,misconfig')
    expect(exposureArgv).not.toContain('-dast')
    expect(exposureArgv[exposureArgv.indexOf('-t') + 1]).toBe('/tpl/http')
    // it runs before the full signature pass
    expect(order.indexOf('exposure-findings.jsonl')).toBeLessThan(order.indexOf('findings.jsonl'))
    expect(out.meta.exposurePhase).toBe('empty')
  })

  it('passes the env concurrency to every phase and records it in meta (#86)', async () => {
    const { out, argv, dastArgv } = await run(
      baseSite({ allowMutatingRequests: true, nucleiPaths: '/search?q=' }),
      FAKE_RECORD_ARGS,
      { SAKUDA_NUCLEI_CONCURRENCY: '8' },
    )
    const cValue = (a: string[]) => a[a.indexOf('-c') + 1]
    expect(cValue(argv)).toBe('8')
    expect(dastArgv).not.toBeNull()
    expect(cValue(dastArgv!)).toBe('8')
    expect(out.meta.concurrency).toBe(8)
  })

  it("the site's nuclei limits override the env ones for every phase and the budget (#10)", async () => {
    const { out, argv, dastArgv } = await run(
      baseSite({
        allowMutatingRequests: true,
        nucleiPaths: '/search?q=',
        nucleiConcurrency: 3,
        nucleiMaxMinutes: 120,
      }),
      FAKE_RECORD_ARGS,
      { SAKUDA_NUCLEI_CONCURRENCY: '8', SAKUDA_NUCLEI_MAX_MINUTES: '30' },
    )
    const cValue = (a: string[]) => a[a.indexOf('-c') + 1]
    expect(cValue(argv)).toBe('3')
    expect(cValue(dastArgv!)).toBe('3')
    expect(out.meta.concurrency).toBe(3)
    expect(out.meta.timeBudget).toMatchObject({
      parts: expect.arrayContaining([{ label: 'nuclei (site setting)', minutes: 120 }]),
    })
  })

  it('opts a risk group back in: both GET phases drop it from -exclude-tags and gain its extra -tags', async () => {
    const { argv, dastArgv } = await run(
      baseSite({ allowMutatingRequests: true, nucleiEnabledRiskTags: ['fuzz'] }),
    )
    // the risk opt-in drops 'fuzz' from the exclusion and adds its extra tags;
    // the full signature pass additionally excludes the priority tags run by
    // the exposure pass (#3), the DAST pass does not.
    expect(dastArgv![dastArgv!.indexOf('-exclude-tags') + 1]).toBe('dos,intrusive')
    expect(argv[argv.indexOf('-exclude-tags') + 1]).toBe('dos,intrusive,exposure,config,misconfig')
    for (const a of [argv, dastArgv!]) {
      expect(a[a.indexOf('-tags') + 1]).toContain('cmdi')
      expect(a[a.indexOf('-tags') + 1]).toContain('rce')
    }
    expect(dastArgv![dastArgv!.indexOf('-tags') + 1]).toBe(argv[argv.indexOf('-tags') + 1])
  })

  it('merges the findings of both GET phases', async () => {
    const { out } = await run(
      baseSite({ allowMutatingRequests: true, nucleiPaths: '/search?q=' }),
      FAKE_SUCCESS,
    )
    // one fake "high" per nuclei run: signature + DAST
    expect(out.counts.high).toBe(2)
    expect(out.findings).toHaveLength(2)
    expect(out.meta.signaturePhase).toBe('ok')
    expect(out.meta.dastPhase).toBe('ok')
    expect(out.exitCode).toBe(0)
  })

  it('keeps the signature findings and warns when the DAST phase fails', async () => {
    const { out } = await run(
      baseSite({ allowMutatingRequests: true, nucleiPaths: '/search?q=' }),
      FAKE_DAST_PHASE_FAILS,
    )
    expect(out.counts.high).toBe(1)
    expect(out.meta.signaturePhase).toBe('ok')
    expect(out.meta.dastPhase).toBe('failed')
    expect(out.exitCode).toBe(1)
    expect(out.warnings).toEqual([expect.stringMatching(/nuclei DAST phase failed/)])
  })

  it('does not report "every phase failed" when the signature phase completed empty and only the DAST phase failed', async () => {
    const { out } = await run(
      baseSite({ allowMutatingRequests: true, nucleiPaths: '/search?q=' }),
      FAKE_DAST_FAILS_OTHERS_EMPTY,
    )
    expect(out.counts.high).toBe(0)
    expect(out.meta.signaturePhase).toBe('empty')
    expect(out.meta.dastPhase).toBe('failed')
    expect(out.exitCode).toBe(1)
    expect(out.warnings).toEqual([expect.stringMatching(/nuclei DAST phase failed/)])
  })

  it('ignores selected risk tags while the opt-in is off (exclusion stays full)', async () => {
    const { argv } = await run(baseSite({ nucleiEnabledRiskTags: ['fuzz', 'dos'] }))
    // full signature pass: the risk groups (opt-in off) plus the priority tags
    // the exposure pass (#3) already covers.
    expect(argv[argv.indexOf('-exclude-tags') + 1]).toBe(
      'dos,fuzz,intrusive,exposure,config,misconfig',
    )
    expect(argv).not.toContain('cmdi')
  })

  it('warns when opted in but no saved target carries query parameters', async () => {
    const { out, dastArgv } = await run(baseSite({ allowMutatingRequests: true }))
    expect(dastArgv).toContain('-dast')
    expect(out.meta.parameterizedUrlCount).toBe(0)
    expect(out.warnings).toEqual([expect.stringMatching(/no saved target has query parameters/)])
  })

  it('stays passive when opted in but ownership of a non-local host is unconfirmed', async () => {
    const { out, argv } = await run(
      baseSite({
        frontBaseUrl: 'https://staging.example.com',
        requiresConfirmation: true,
        nonLocalConfirmed: false,
        allowMutatingRequests: true,
        nucleiEnabledRiskTags: [],
      }),
    )
    expect(argv).not.toContain('-dast')
    expect(out.meta.activeScan).toBe(false)
    expect(out.meta.dastPhase).toBe('skipped')
  })
})

// One "high" finding per run; the stats line's percent comes from
// FAKE_PERCENT, and FAKE_SKIP_HOST (when set) makes the binary print
// nuclei's "Skipped <host> ... unresponsive" line to stderr — the shape of a
// run nuclei's -max-host-error guard cut short (#82).
const FAKE_PARTIAL = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const outFile = args[args.indexOf('-o') + 1]
// The priority exposure pass (#3) completes clean here (empty, 100%) so these
// #82 partial-coverage assertions stay about the full signature pass.
const isExposure = outFile.includes('exposure')
const finding = {
  'template-id': 'fake-high',
  info: { name: 'Fake High', severity: 'high' },
  host: 'localhost:3001',
  'matched-at': 'http://localhost:3001/a',
}
fs.writeFileSync(outFile, isExposure ? '' : JSON.stringify(finding) + '\\n')
if (process.env.FAKE_SKIP_HOST && !isExposure)
  console.error('[INF] Skipped ' + process.env.FAKE_SKIP_HOST + ' from target list as found unresponsive 33 times')
console.log(JSON.stringify({ requests: '70268', errors: '1557', total: '868770', percent: isExposure ? '100' : process.env.FAKE_PERCENT }))
console.error('[INF] Scan completed in 16m. 1 matches found.')
process.exit(0)
`

describe('runNuclei partial phase detection (#82)', () => {
  let tmp: string
  const logger = pino({ level: 'silent' })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sakuda-nuclei-partial-'))
  })

  async function run(fakeEnv: Record<string, string>) {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_PARTIAL)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      ...FAKE_HTTPX_ENV,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const savedEnv = { ...process.env }
    Object.assign(process.env, fakeEnv)
    try {
      return await runNuclei({
        scanId: 'scan-partial',
        engine: 'nuclei',
        site: baseSite(),
        workDir,
        env,
        logger,
        signal: new AbortController().signal,
      })
    } finally {
      process.env = savedEnv
    }
  }

  it('marks the signature phase partial and warns when nuclei skipped the host, keeping its findings', async () => {
    const out = await run({ FAKE_PERCENT: '8', FAKE_SKIP_HOST: 'localhost:3001' })
    expect(out.meta.signaturePhase).toBe('partial')
    expect(out.counts.high).toBe(1)
    expect(out.exitCode).toBe(0)
    expect(out.warnings).toEqual([
      expect.stringMatching(
        /nuclei signature phase is partial: host localhost:3001 was skipped after 33 errors .*8% of planned requests executed \(70268\/868770, 1557 errors\)/,
      ),
    ])
  })

  it('marks the phase partial on coverage below 100% even without a skipped-host line', async () => {
    const out = await run({ FAKE_PERCENT: '42' })
    expect(out.meta.signaturePhase).toBe('partial')
    expect(out.warnings).toEqual([expect.stringMatching(/42% of planned requests executed/)])
    expect(out.warnings[0]).not.toMatch(/was skipped/)
  })

  it('reports a fully covered run as ok with no partial warning', async () => {
    const out = await run({ FAKE_PERCENT: '100' })
    expect(out.meta.signaturePhase).toBe('ok')
    expect(out.warnings).toEqual([])
  })
})

// Fake httpx: reads `-l`, prints one `-probe`-style JSONL line per input to
// stdout. A line whose path ends in `/gone` gets 404, `/down` a transport
// failure, `/silent` no line at all, anything else 200. Records argv next to
// the targets file.
const FAKE_HTTPX = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const targetsFile = args[args.indexOf('-l') + 1]
fs.writeFileSync(path.join(path.dirname(targetsFile), 'argv.json'), JSON.stringify(args))
if (args.includes('-config'))
  fs.copyFileSync(args[args.indexOf('-config') + 1], path.join(path.dirname(targetsFile), 'seen-headers.json'))
for (const input of fs.readFileSync(targetsFile, 'utf8').trim().split('\\n')) {
  const p = new URL(input).pathname
  if (p.endsWith('/silent')) continue
  if (p.endsWith('/down')) { console.log(JSON.stringify({ input, status_code: 0, failed: true, error: 'connection refused' })); continue }
  console.log(JSON.stringify({ input, url: input, status_code: p.endsWith('/gone') ? 404 : 200, failed: false }))
}
process.exit(0)
`

const FAKE_HTTPX_CRASHES = `#!/usr/bin/env node
console.error('boom')
process.exit(1)
`

describe('runNuclei httpx liveness probe (#91)', () => {
  let tmp: string
  const logger = pino({ level: 'silent' })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sakuda-nuclei-httpx-'))
  })

  async function run(
    site: SiteWithHeaders,
    fakeHttpx: string | null,
    extraEnv: Record<string, string> = {},
  ) {
    const fakeBin = writeFakeBin(tmp, 'fake-nuclei.js', FAKE_RECORD_ARGS)
    const httpxBin =
      fakeHttpx === null ? NO_HTTPX.SAKUDA_HTTPX_BIN : writeFakeBin(tmp, 'fake-httpx.js', fakeHttpx)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_BIN: fakeBin,
      SAKUDA_HTTPX_BIN: httpxBin,
      SAKUDA_DATA_DIR: tmp,
      ...extraEnv,
    })
    const workDir = join(tmp, 'work')
    const out = await runNuclei({
      scanId: 'scan-httpx',
      engine: 'nuclei',
      site,
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })
    const targets = existsSync(join(workDir, 'targets.txt'))
      ? readFileSync(join(workDir, 'targets.txt'), 'utf8')
      : null
    const httpxDir = join(workDir, 'httpx')
    // as: written by the fake httpx above as JSON string[]
    const httpxArgv = existsSync(join(httpxDir, 'argv.json'))
      ? (JSON.parse(readFileSync(join(httpxDir, 'argv.json'), 'utf8')) as string[])
      : null
    // as: meta.httpx is the probe's typed meta, opaque to EngineOutput
    const httpx = out.meta.httpx as Record<string, unknown> | undefined
    return { out, targets, httpxDir, httpxArgv, httpx }
  }

  const site = () =>
    baseSite({
      nucleiPaths: '/ok\n/gone\n/down\n/silent',
      headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
    })

  it('by default keeps every target — a 404 stays in the nuclei list — and only annotates meta', async () => {
    const { out, targets, httpx } = await run(site(), FAKE_HTTPX)
    expect(targets).toBe(
      'http://localhost:3001/ok\nhttp://localhost:3001/gone\nhttp://localhost:3001/down\nhttp://localhost:3001/silent\n',
    )
    expect(httpx).toMatchObject({
      status: 'ok',
      inputCount: 4,
      observedCount: 3,
      unobservedCount: 1,
      failedCount: 1,
      keptCount: 4,
      droppedCount: 0,
      droppedUrls: [],
      statusCounts: { '200': 1, '404': 1 },
      pruneStatusCodes: [],
      exitCode: 0,
    })
    expect(out.warnings).toEqual([])
    expect(out.meta.urlCount).toBe(4)
  })

  it('writes its artifacts under nuclei/httpx/ (0600); headers reach httpx via the run-scoped -config file, never argv (#95)', async () => {
    const { httpxDir, httpxArgv } = await run(site(), FAKE_HTTPX)
    for (const f of ['targets.txt', 'stdout.jsonl', 'stderr.log', 'args.json']) {
      const p = join(httpxDir, f)
      expect(existsSync(p), f).toBe(true)
      expect(statSync(p).mode & 0o777, f).toBe(0o600)
    }
    const headersFile = join(tmp, 'work', 'headers.json')
    expect(httpxArgv).toContain('-config')
    expect(httpxArgv![httpxArgv!.indexOf('-config') + 1]).toBe(headersFile)
    expect(httpxArgv).not.toContain('-H')
    expect(JSON.stringify(httpxArgv)).not.toContain('secret-token')
    expect(readFileSync(join(httpxDir, 'args.json'), 'utf8')).not.toContain('secret-token')
    expect(httpxArgv).not.toContain('-fr')
    expect(httpxArgv).toContain('-nfs')
    expect(httpxArgv).toContain('-probe')
    // httpx could read the headers while it ran; the file is gone once the run ends
    expect(JSON.parse(readFileSync(join(httpxDir, 'seen-headers.json'), 'utf8'))).toEqual({
      header: ['Authorization: Bearer secret-token'],
    })
    expect(existsSync(headersFile)).toBe(false)
    expect(readFileSync(join(httpxDir, 'stdout.jsonl'), 'utf8')).toContain('"status_code":404')
  })

  it('shares the same headers file with every nuclei phase and passes no -config without headers (#95)', async () => {
    const withHeaders = await run(
      baseSite({
        allowMutatingRequests: true,
        nucleiPaths: '/search?q=',
        headers: [{ name: 'Cookie', value: 'token=secret' }],
      }),
      FAKE_HTTPX,
    )
    const workDir = join(tmp, 'work')
    const headersFile = join(workDir, 'headers.json')
    // as: written by the fake nuclei as JSON string[]
    const argvOf = (output: string) =>
      JSON.parse(readFileSync(join(workDir, `argv-${output}.json`), 'utf8')) as string[]
    for (const phase of ['findings.jsonl', 'dast-findings.jsonl']) {
      const argv = argvOf(phase)
      expect(argv.slice(-2), phase).toEqual(['-config', headersFile])
      expect(JSON.stringify(argv), phase).not.toContain('token=secret')
      expect(
        JSON.parse(readFileSync(join(workDir, `seen-headers-${phase}.json`), 'utf8')),
        phase,
      ).toEqual({ header: ['Cookie: token=secret'] })
    }
    expect(existsSync(headersFile)).toBe(false)
    void withHeaders

    const without = await run(baseSite({ nucleiPaths: '/plain' }), FAKE_HTTPX)
    expect(argvOf('findings.jsonl')).not.toContain('-config')
    expect(without.httpxArgv).not.toContain('-config')
  })

  it('with the opt-in drops only the target httpx positively saw on the list; unknown stays', async () => {
    const { targets, httpx, out } = await run(site(), FAKE_HTTPX, {
      SAKUDA_HTTPX_PRUNE_STATUS_CODES: '404,410',
    })
    expect(targets).toBe(
      'http://localhost:3001/ok\nhttp://localhost:3001/down\nhttp://localhost:3001/silent\n',
    )
    expect(httpx).toMatchObject({
      keptCount: 3,
      droppedCount: 1,
      droppedUrls: ['http://localhost:3001/gone'],
      pruneStatusCodes: [404, 410],
    })
    expect(out.warnings).toEqual([expect.stringMatching(/httpx pruned 1 target/)])
  })

  it('passes every target through with a warning when httpx is not installed', async () => {
    const { targets, httpx, out } = await run(site(), null, {
      SAKUDA_HTTPX_PRUNE_STATUS_CODES: '404',
    })
    expect(targets!.split('\n').filter(Boolean)).toHaveLength(4)
    expect(httpx).toMatchObject({ status: 'unavailable', keptCount: 4, droppedCount: 0 })
    expect(out.warnings).toEqual([expect.stringMatching(/httpx liveness probe did not run/)])
    expect(out.meta.signaturePhase).toBe('empty')
  })

  it('passes every target through with a warning when httpx fails', async () => {
    const { targets, httpx, out } = await run(site(), FAKE_HTTPX_CRASHES, {
      SAKUDA_HTTPX_PRUNE_STATUS_CODES: '404',
    })
    expect(targets!.split('\n').filter(Boolean)).toHaveLength(4)
    expect(httpx).toMatchObject({ status: 'failed', exitCode: 1, keptCount: 4 })
    expect(out.warnings).toEqual([expect.stringMatching(/httpx liveness probe failed \(exit 1/)])
  })

  it('records the probe in the run budget the page shows (#84)', async () => {
    const { out } = await run(site(), FAKE_HTTPX, { SAKUDA_HTTPX_MAX_MINUTES: '2' })
    expect(out.meta.timeBudget).toMatchObject({
      parts: [expect.objectContaining({ minutes: 2 }), expect.objectContaining({ minutes: 60 })],
      totalMinutes: 62,
    })
  })
})
