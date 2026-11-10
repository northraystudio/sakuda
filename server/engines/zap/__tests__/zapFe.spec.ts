import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import YAML from 'yaml'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseEnv, type Env } from '../../../config/env'
import type { SiteWithHeaders } from '../../../services/siteService'
import { EngineError } from '../../types'
import { runZapFe } from '../zapFe'
import { writeFakeZap } from './fakeZap'

const FIXTURE = join(__dirname, 'fixtures', 'zap-report.json')
const key = randomBytes(32).toString('base64')
const logger = pino({ level: 'silent' })

function baseSite(overrides: Partial<SiteWithHeaders> = {}): SiteWithHeaders {
  return {
    id: 'site-1',
    name: 'shop',
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

describe('runZapFe', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sakuda-zapfe-'))
  })

  it('runs the fake zap.sh and normalizes 2 high findings from the fixture', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_LOCALHOST_ALIAS: 'host.docker.internal',
    })
    const workDir = join(tmp, 'work')
    const site = baseSite({ headers: [{ name: 'Cookie', value: 'a=b' }], headerNames: ['Cookie'] })

    const out = await runZapFe({
      scanId: 'scan-1',
      engine: 'zap-fe',
      site,
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(out.counts.high).toBe(2)
    expect(out.meta.zapVersion).toBe('2.17.0')
    expect(out.meta.seedUrls).toEqual(['http://localhost:3000/'])
    expect(out.meta.spider).toBe('traditional + ajax')
    // the budget the runner enforced is recorded for the page (#84)
    expect(out.meta.timeBudget).toMatchObject({ totalMinutes: expect.any(Number) })
    // findings' urls are un-aliased back from host.docker.internal to the real host
    expect(out.findings.every((f) => f.url.includes('localhost:3000'))).toBe(true)
    expect(out.findings.some((f) => f.url.includes('host.docker.internal'))).toBe(false)

    const plan: unknown = YAML.parse(readFileSync(join(workDir, 'plan.yaml'), 'utf8'))
    // as: plan is Record<string, unknown> at runtime; narrow just enough to assert the spider url
    const jobs = (plan as { jobs: Array<{ type: string; parameters: Record<string, unknown> }> })
      .jobs
    const spider = jobs.find((j) => j.type === 'spider')
    expect(spider?.parameters.url).toBe('http://host.docker.internal:3000/')
    // Even with no excludePaths configured, socket.io stays out of the scan
    // scope — left in, the active scan stalls ~30s per rule on the transport.
    // as: plan is Record<string, unknown> at runtime; narrow just enough for the context
    const context = (plan as { env: { contexts: Array<{ excludePaths: string[] }> } }).env
      .contexts[0]
    expect(context?.excludePaths).toEqual(['^https?://[^/]+/socket\\.io.*(\\?.*)?$'])
    // default: passive only — no activeScan job, and the report says so
    expect(jobs.some((j) => j.type === 'activeScan')).toBe(false)
    expect(out.meta.activeScan).toBe(false)
    expect(out.meta).not.toHaveProperty('activeScanMaxMinutes')
  })

  // as: plan.yaml is Record<string, unknown> at runtime; narrow just enough to list the jobs
  const readPlanJobs = (workDir: string) =>
    (
      YAML.parse(readFileSync(join(workDir, 'plan.yaml'), 'utf8')) as {
        jobs: Array<{
          type: string
          parameters: Record<string, unknown>
          requests?: Array<{ url: string; method: string }>
        }>
      }
    ).jobs

  it('adds the activeScan job (capped by zapApiMaxMinutes) when the site opted into active checks', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const site = baseSite({ allowMutatingRequests: true, zapApiMaxMinutes: 30 })

    const out = await runZapFe({
      scanId: 'scan-5',
      engine: 'zap-fe',
      site,
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    const jobs = readPlanJobs(workDir)
    // the two `script` jobs are the site-tree dump (add + run) right after the spiders
    expect(jobs.map((j) => j.type)).toEqual([
      'passiveScan-config',
      'spider',
      'spiderAjax',
      'script',
      'script',
      'activeScan',
      'passiveScan-wait',
      'report',
      'report',
    ])
    expect(jobs[5]?.parameters.maxScanDurationInMins).toBe(30)
    expect(out.meta.activeScan).toBe(true)
    expect(out.meta.activeScanMaxMinutes).toBe(30)
  })

  it('requests the saved front-origin targets (alias-rewritten, no hash routes) before the active scan', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_ZAP_LOCALHOST_ALIAS: 'host.docker.internal',
    })
    const workDir = join(tmp, 'work')
    const site = baseSite({
      apiBaseUrl: 'http://localhost:8080',
      nucleiPaths: '/search?q=\n/#/search?q=\napi:/v1/users\n/login',
      excludePaths: '/login',
      allowMutatingRequests: true,
    })

    const out = await runZapFe({
      scanId: 'scan-6',
      engine: 'zap-fe',
      site,
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    const jobs = readPlanJobs(workDir)
    // site-tree dump (script add + run) after the spiders; the `/#/search?q=`
    // hash route also drives the DOM XSS probe (script add + run) after the active scan
    expect(jobs.map((j) => j.type)).toEqual([
      'passiveScan-config',
      'spider',
      'spiderAjax',
      'script',
      'script',
      'requestor',
      'activeScan',
      'script',
      'script',
      'passiveScan-wait',
      'report',
      'report',
    ])
    // active run: the empty query value is seeded like nuclei's targets file
    expect(jobs[5]?.requests).toEqual([
      { url: 'http://host.docker.internal:3000/search?q=1', method: 'GET' },
    ])
    expect(out.meta.targetUrlCount).toBe(1)
  })

  it('requestor gets GET targets only; non-GET saved lines are counted in meta.skippedMethods', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const out = await runZapFe({
      scanId: 'scan-skip',
      engine: 'zap-fe',
      site: baseSite({ nucleiPaths: '/get?q=\nPOST /api/x\nDELETE /api/y' }),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })
    const requestor = readPlanJobs(workDir).find((j) => j.type === 'requestor')
    expect(requestor?.requests).toEqual([{ url: 'http://localhost:3000/get?q=', method: 'GET' }])
    expect(out.meta.skippedMethods).toEqual({ POST: 1, DELETE: 1 })
  })

  it('under active checks, the requestor sends non-GET with its own method (seeded), nothing skipped', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const out = await runZapFe({
      scanId: 'scan-active-req',
      engine: 'zap-fe',
      site: baseSite({
        allowMutatingRequests: true,
        nucleiPaths: '/get?q=\nPOST /api/x?p=\nDELETE /api/y',
      }),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })
    const requestor = readPlanJobs(workDir).find((j) => j.type === 'requestor')
    // GET + POST (empty query seeded) + DELETE, each with its own method
    expect(requestor?.requests).toEqual([
      { url: 'http://localhost:3000/get?q=1', method: 'GET' },
      { url: 'http://localhost:3000/api/x?p=1', method: 'POST' },
      { url: 'http://localhost:3000/api/y', method: 'DELETE' },
    ])
    expect(out.meta.skippedMethods).toBeUndefined()
    // the spider submits forms as POST only under active checks
    const spider = readPlanJobs(workDir).find((j) => j.type === 'spider')
    expect(spider?.parameters.postForm).toBe(true)
  })

  it('sends a mutating request once when query seeding makes two saved lines the same request', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const out = await runZapFe({
      scanId: 'scan-seed-collision',
      engine: 'zap-fe',
      // distinct saved lines; under active checks `?q=` is seeded to `?q=1`
      site: baseSite({ allowMutatingRequests: true, nucleiPaths: 'POST /s?q=\nPOST /s?q=1' }),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })
    const requestor = readPlanJobs(workDir).find((j) => j.type === 'requestor')
    expect(requestor?.requests).toEqual([{ url: 'http://localhost:3000/s?q=1', method: 'POST' }])
    expect(out.meta.targetUrlCount).toBe(1)
  })

  it('passes the saved targets verbatim (no query seeding) on a passive run, and none when the list is empty', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const run = (workDir: string, nucleiPaths: string) =>
      runZapFe({
        scanId: 'scan-7',
        engine: 'zap-fe',
        site: baseSite({ nucleiPaths }),
        workDir,
        env,
        logger,
        signal: new AbortController().signal,
      })

    const passive = await run(join(tmp, 'passive'), '/search?q=')
    const requestor = readPlanJobs(join(tmp, 'passive')).find((j) => j.type === 'requestor')
    expect(requestor?.requests).toEqual([{ url: 'http://localhost:3000/search?q=', method: 'GET' }])
    expect(passive.meta.targetUrlCount).toBe(1)

    const none = await run(join(tmp, 'none'), '')
    expect(readPlanJobs(join(tmp, 'none')).some((j) => j.type === 'requestor')).toBe(false)
    expect(none.meta.targetUrlCount).toBe(0)
  })

  it('runs the DOM XSS probe on hash routes only when opted in, and records hashRouteCount', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_ZAP_LOCALHOST_ALIAS: 'host.docker.internal',
    })
    const run = (workDir: string, allow: boolean) =>
      runZapFe({
        scanId: 'scan-dom',
        engine: 'zap-fe',
        site: baseSite({
          nucleiPaths: '/#/search?q=\n/#/track?id=\n/plain',
          allowMutatingRequests: allow,
        }),
        workDir,
        env,
        logger,
        signal: new AbortController().signal,
      })

    // opted in: two probe script jobs after the active scan, the probe script written
    const probeJobsOf = (workDir: string) =>
      readPlanJobs(workDir).filter(
        (j) => j.type === 'script' && j.parameters.name === 'sakuda-dom-xss-probe',
      )
    const on = await run(join(tmp, 'on'), true)
    const scriptJobs = probeJobsOf(join(tmp, 'on'))
    expect(scriptJobs.map((j) => j.parameters.action)).toEqual(['add', 'run'])
    const addJob = scriptJobs[0]!
    expect(addJob.parameters.type).toBe('standalone')
    expect(String(addJob.parameters.file)).toContain('dom-xss-probe.js')
    // the script embeds the alias-rewritten hash routes, not the plain path
    const scriptText = readFileSync(join(tmp, 'on', 'dom-xss-probe.js'), 'utf8')
    expect(scriptText).toContain('http://host.docker.internal:3000/#/search?q=')
    expect(scriptText).toContain('http://host.docker.internal:3000/#/track?id=')
    expect(scriptText).not.toContain('/plain')
    expect(on.meta.hashRouteCount).toBe(2)

    // opted out: no probe job at all
    const off = await run(join(tmp, 'off'), false)
    expect(probeJobsOf(join(tmp, 'off'))).toEqual([])
    expect(off.meta.hashRouteCount).toBe(0)
  })

  it('narrows the context to the crawl scope: front prefixes, the seed and the api subtree', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_ZAP_LOCALHOST_ALIAS: 'host.docker.internal',
    })
    const workDir = join(tmp, 'work')

    await runZapFe({
      scanId: 'scan-scope',
      engine: 'zap-fe',
      site: baseSite({
        apiBaseUrl: 'http://localhost:8080',
        zapFeSeedPath: '/#/',
        crawlScopePaths: '/rest',
      }),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    const plan: unknown = YAML.parse(readFileSync(join(workDir, 'plan.yaml'), 'utf8'))
    // as: narrow just enough for the context
    const context = (
      plan as { env: { contexts: Array<{ urls: string[]; includePaths: string[] }> } }
    ).env.contexts[0]
    expect(context?.urls).toEqual([
      'http://host.docker.internal:3000/rest/',
      'http://host.docker.internal:8080/',
    ])
    expect(context?.includePaths).toEqual([
      '^http:\\/\\/host\\.docker\\.internal:3000\\/rest(/.*)?(\\?.*)?$',
      '^http:\\/\\/host\\.docker\\.internal:3000\\/(#.*)?$',
      '^http:\\/\\/host\\.docker\\.internal:8080(/.*)?$',
    ])
  })

  it('keeps the active scan off for an unconfirmed non-local site even when opted in', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const site = baseSite({
      frontBaseUrl: 'https://staging.example.test',
      allowMutatingRequests: true,
      requiresConfirmation: true,
      nonLocalConfirmed: false,
    })

    const out = await runZapFe({
      scanId: 'scan-6',
      engine: 'zap-fe',
      site,
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(readPlanJobs(workDir).some((j) => j.type === 'activeScan')).toBe(false)
    expect(out.meta.activeScan).toBe(false)
  })

  it("tells the Ajax spider's Firefox to treat the localhost alias as a secure context", async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_LOCALHOST_ALIAS: 'host.docker.internal',
    })
    const workDir = join(tmp, 'work')

    await runZapFe({
      scanId: 'scan-1',
      engine: 'zap-fe',
      site: baseSite(),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    const argv = JSON.parse(readFileSync(join(workDir, 'argv.json'), 'utf8')) as string[]
    expect(argv.filter((a) => a.startsWith('selenium.firefoxPrefs.'))).toEqual([
      'selenium.firefoxPrefs.pref(0).name=dom.securecontext.allowlist',
      'selenium.firefoxPrefs.pref(0).value=host.docker.internal',
      'selenium.firefoxPrefs.pref(0).enabled=true',
    ])
  })

  it('sets no Firefox pref when no localhost alias is configured', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')

    await runZapFe({
      scanId: 'scan-1',
      engine: 'zap-fe',
      site: baseSite(),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    const argv = JSON.parse(readFileSync(join(workDir, 'argv.json'), 'utf8')) as string[]
    expect(argv).not.toContain('-config')
  })

  describe('seed reachability (site-tree dump + spider access failures, never the alerts)', () => {
    // Fixture site tree: the spiders crawled `/`, `/api/...`, `/rest/...`, `/admin/config` — no `/dash`.
    const SITE_TREE = join(__dirname, 'fixtures', 'site-tree.jsonl')
    const withHeaders = (seed: string) =>
      baseSite({
        headers: [{ name: 'Cookie', value: 'a=b' }],
        headerNames: ['Cookie'],
        zapFeSeedPath: seed,
      })
    const runWith = (site: SiteWithHeaders, workDir: string, dump = SITE_TREE) => {
      const fakeBin = writeFakeZap(tmp, FIXTURE, 'fake-zap.js', 'report.json', {
        'site-tree.jsonl': dump,
      })
      const env: Env = parseEnv({
        SAKUDA_ENCRYPTION_KEY: key,
        SAKUDA_ZAP_CMD: fakeBin,
        SAKUDA_DATA_DIR: tmp,
        SAKUDA_LOCALHOST_ALIAS: 'host.docker.internal',
      })
      return runZapFe({
        scanId: 'scan-2',
        engine: 'zap-fe',
        site,
        workDir,
        env,
        logger,
        signal: new AbortController().signal,
      })
    }
    const seedWarning = (out: { warnings: string[] }) =>
      out.warnings.find((w) => w.includes('seed path'))
    const reachWarning = (out: { warnings: string[] }) =>
      out.warnings.find((w) => w.includes('could not reach the seed URL'))

    it('warns about the seed path only when the crawled URLs (site tree) lack it', async () => {
      const missing = await runWith(withHeaders('/dash'), join(tmp, 'missing'))
      expect(seedWarning(missing)).toBe(
        'seed path /dash was not among the URLs the spider crawled — the session may not have been accepted; check the site headers',
      )
      expect(reachWarning(missing)).toBeUndefined()
      // 10 crawled entries in the fixture (structural nodes and the bad line excluded), un-aliased
      expect(missing.meta.crawledUrlCount).toBe(10)
      // the dump script was written for ZAP and referenced by the plan
      expect(existsSync(join(tmp, 'missing', 'dump-site-tree.js'))).toBe(true)

      // `/admin/config` is in the tree (even though it never raised an alert): no warning
      const present = await runWith(withHeaders('/admin/config/'), join(tmp, 'present'))
      expect(seedWarning(present)).toBeUndefined()
    })

    it('never blames the fragment: a hash-route seed is not checked', async () => {
      const out = await runWith(withHeaders('/#/dashboard'), join(tmp, 'hash'))
      expect(seedWarning(out)).toBeUndefined()
      expect(reachWarning(out)).toBeUndefined()
    })

    it('reports an unreachable target instead of an auth problem when the spider failed on the seed', async () => {
      process.env.FAKE_ZAP_STDERR =
        'Picked up JAVA_TOOL_OPTIONS: -Xmx1024m\nJob spider failed to access URL http://host.docker.internal:3000/dash/ : Network is unreachable\n'
      try {
        const out = await runWith(withHeaders('/dash'), join(tmp, 'unreachable'))
        expect(reachWarning(out)).toBe(
          'spider could not reach the seed URL /dash (Network is unreachable) — verify the target is up and reachable from the ZAP container (host alias / network) before checking the site headers',
        )
        expect(seedWarning(out)).toBeUndefined()
      } finally {
        delete process.env.FAKE_ZAP_STDERR
      }
    })

    it('skips the seed check when the dump has no readable entry (a corrupt dump is not an empty crawl)', async () => {
      const corrupt = join(tmp, 'corrupt-site-tree.jsonl')
      writeFileSync(corrupt, '{"method":"GET"\nnot json at all\n')
      const out = await runWith(withHeaders('/dash'), join(tmp, 'corrupt'), corrupt)
      expect(seedWarning(out)).toBeUndefined()
      expect(out.meta).not.toHaveProperty('crawledUrlCount')
    })

    it('skips the seed check (and records no crawled count) when the dump is missing', async () => {
      const fakeBin = writeFakeZap(tmp, FIXTURE)
      const env: Env = parseEnv({
        SAKUDA_ENCRYPTION_KEY: key,
        SAKUDA_ZAP_CMD: fakeBin,
        SAKUDA_DATA_DIR: tmp,
      })
      const out = await runZapFe({
        scanId: 'scan-2',
        engine: 'zap-fe',
        site: withHeaders('/dash'),
        workDir: join(tmp, 'nodump'),
        env,
        logger,
        signal: new AbortController().signal,
      })
      expect(seedWarning(out)).toBeUndefined()
      expect(out.meta).not.toHaveProperty('crawledUrlCount')
    })
  })

  it('registers the browser-storage selenium script when the site has storage items, and removes it after', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const site = baseSite({
      browserStorage: [{ kind: 'localStorage', name: 'token', value: 'eyJ.secret' }],
      browserStorageNames: [{ kind: 'localStorage', name: 'token' }],
    })

    const out = await runZapFe({
      scanId: 'scan-4',
      engine: 'zap-fe',
      site,
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(JSON.parse(readFileSync(join(workDir, 'secret-mode.json'), 'utf8'))).toBe(0o600)
    expect(existsSync(join(workDir, 'browser-storage.js'))).toBe(false)
    const plan: unknown = YAML.parse(readFileSync(join(workDir, 'plan.yaml'), 'utf8'))
    // as: narrow just enough to find the selenium jobs
    const jobs = (plan as { jobs: Array<{ type: string; parameters: Record<string, unknown> }> })
      .jobs
    expect(
      jobs.filter((j) => j.parameters.type === 'selenium').map((j) => j.parameters.action),
    ).toEqual(['add', 'enable'])
    expect(out.meta.browserStorage).toEqual(['localStorage:token'])
    expect(JSON.stringify(out)).not.toContain('eyJ.secret')
  })

  it('throws EngineError when zap.sh produces no report', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE)
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    process.env.FAKE_ZAP_NO_REPORT = '1'
    try {
      await expect(
        runZapFe({
          scanId: 'scan-3',
          engine: 'zap-fe',
          site: baseSite(),
          workDir,
          env,
          logger,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(EngineError)
    } finally {
      delete process.env.FAKE_ZAP_NO_REPORT
    }
  })
})
