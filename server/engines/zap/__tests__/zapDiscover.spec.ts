import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import YAML from 'yaml'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseEnv, type Env } from '../../../config/env'
import type { SiteWithHeaders } from '../../../services/siteService'
import { EngineError } from '../../types'
import { runZapDiscover } from '../zapDiscover'
import { writeFakeZap } from './fakeZap'

const FIXTURE = join(__dirname, 'fixtures', 'site-tree.jsonl')
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
    excludePaths: '/admin/*',
    nucleiRateLimit: 50,
    zapApiMaxMinutes: 45,
    zapFeSpiderMaxMinutes: 5,
    nonLocalConfirmed: false,
    allowMutatingRequests: false,
    nucleiEnabledRiskTags: [],
    nucleiTags: [],
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

interface PlanShape {
  env: { contexts: Array<{ includePaths: string[]; excludePaths: string[] }> }
  jobs: Array<{ type: string; parameters: Record<string, unknown> }>
}

describe('runZapDiscover', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sakuda-discover-'))
  })

  it('runs the fake zap.sh with a crawl-only plan and normalizes the site-tree dump', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_LOCALHOST_ALIAS: 'host.docker.internal',
    })
    const workDir = join(tmp, 'work')
    const site = baseSite({ headers: [{ name: 'Cookie', value: 'a=b' }], headerNames: ['Cookie'] })

    const out = await runZapDiscover({
      discoveryId: 'disc-1',
      site,
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    // Un-aliased back to the real host; deduped; assets / noise / excluded /
    // off-origin dropped; a 401 is kept (it is a real endpoint) but flagged.
    expect(out.urls).toEqual([
      { url: 'http://localhost:3000/', method: 'GET', statusCode: 200, source: 'spider' },
      {
        url: 'http://localhost:3000/api/Challenges/?name=Score%20Board',
        method: 'GET',
        statusCode: 200,
        source: 'spider',
      },
      {
        url: 'http://localhost:3000/rest/products/search?q=',
        method: 'GET',
        statusCode: 200,
        source: 'ajax',
      },
      {
        url: 'http://localhost:3000/rest/basket/6',
        method: 'GET',
        statusCode: 401,
        source: 'ajax',
      },
    ])
    expect(out.meta).toMatchObject({
      seedUrls: ['http://localhost:3000/'],
      browserStorage: [],
      spider: 'traditional + ajax',
      nodeCount: 12,
      structuralCount: 2,
      urlCount: 4,
      dropped: { invalid: 0, sameOriginOnly: 1, asset: 1, noise: 2, excluded: 1, capped: 0 },
      authFailureCount: 1,
      timedOut: false,
    })
    expect(out.warnings).toEqual([
      '1 request(s) returned 401 Unauthorized — the auth headers may be missing or expired',
      '1 unparsable line(s) in the site-tree dump were ignored',
    ])

    // The plan is crawl-only (no report job) and references the script we wrote.
    const plan: unknown = YAML.parse(readFileSync(join(workDir, 'plan.yaml'), 'utf8'))
    // as: plan is Record<string, unknown> at runtime; narrow just enough to assert the job list
    const { env: planEnv, jobs } = plan as PlanShape
    expect(jobs.map((j) => j.type)).toEqual([
      'passiveScan-config',
      'spider',
      'spiderAjax',
      'script',
      'script',
    ])
    expect(jobs[0]?.parameters).toEqual({ disableAllRules: true })
    expect(jobs[1]?.parameters.url).toBe('http://host.docker.internal:3000/')
    expect(jobs[3]?.parameters.file).toBe(join(workDir, 'dump-site-tree.js'))
    expect(planEnv.contexts[0]?.includePaths).toEqual([
      '^http:\\/\\/host\\.docker\\.internal:3000(/.*)?$',
    ])
    // The site's own excludePaths, plus the always-on scan noise (socket.io):
    // dropping it from the discovered URLs is not enough, it has to leave the
    // spider's scope too.
    expect(planEnv.contexts[0]?.excludePaths).toEqual([
      '^https?://[^/]+/admin/.*(\\?.*)?$',
      '^https?://[^/]+/socket\\.io.*(\\?.*)?$',
    ])
    const script = readFileSync(join(workDir, 'dump-site-tree.js'), 'utf8')
    expect(script).toContain(JSON.stringify(join(workDir, 'site-tree.jsonl')))
    // Header values never linger on disk after the run.
    expect(existsSync(join(workDir, 'replacer.conf'))).toBe(false)
  })

  it("tells the Ajax spider's Firefox to treat the localhost alias as a secure context", async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_LOCALHOST_ALIAS: 'host.docker.internal',
    })
    const workDir = join(tmp, 'work')

    await runZapDiscover({
      discoveryId: 'disc-1',
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
    const fakeBin = writeFakeZap(tmp, FIXTURE, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')

    await runZapDiscover({
      discoveryId: 'disc-1',
      site: baseSite(),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    const argv = JSON.parse(readFileSync(join(workDir, 'argv.json'), 'utf8')) as string[]
    expect(argv).not.toContain('-config')
  })

  it('also scopes the crawl to the api base URL when one is set', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')

    await runZapDiscover({
      discoveryId: 'disc-2',
      site: baseSite({ apiBaseUrl: 'http://localhost:8080' }),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    const plan: unknown = YAML.parse(readFileSync(join(workDir, 'plan.yaml'), 'utf8'))
    // as: see above
    const { env: planEnv } = plan as PlanShape
    expect(planEnv.contexts[0]?.includePaths).toEqual([
      '^http:\\/\\/localhost:3000(/.*)?$',
      '^http:\\/\\/localhost:8080(/.*)?$',
    ])
  })

  it('narrows the context to the crawl scope: roots as context URLs, prefixes + seeds + api included; drops out-of-scope URLs', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
      SAKUDA_LOCALHOST_ALIAS: 'host.docker.internal',
    })
    const workDir = join(tmp, 'work')

    const out = await runZapDiscover({
      discoveryId: 'disc-scope',
      site: baseSite({
        apiBaseUrl: 'http://localhost:8080',
        discoverySeedPaths: '/#/',
        crawlScopePaths: '/rest\n/api/Challenges',
      }),
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    const plan: unknown = YAML.parse(readFileSync(join(workDir, 'plan.yaml'), 'utf8'))
    // as: see above
    const { env: planEnv, jobs } = plan as {
      env: PlanShape['env'] & { contexts: Array<{ urls: string[] }> }
      jobs: PlanShape['jobs']
    }
    // AF turns each context URL into `<url>.*`, so the seed must not be one — the roots are
    expect(planEnv.contexts[0]?.urls).toEqual([
      'http://host.docker.internal:3000/rest/',
      'http://host.docker.internal:3000/api/Challenges/',
      'http://host.docker.internal:8080/',
    ])
    expect(planEnv.contexts[0]?.includePaths).toEqual([
      '^http:\\/\\/host\\.docker\\.internal:3000\\/rest(/.*)?(\\?.*)?$',
      '^http:\\/\\/host\\.docker\\.internal:3000\\/api\\/Challenges(/.*)?(\\?.*)?$',
      '^http:\\/\\/host\\.docker\\.internal:3000\\/(#.*)?$',
      '^http:\\/\\/host\\.docker\\.internal:8080(/.*)?$',
    ])
    // the spiders still start from the seed
    expect(jobs[1]?.parameters.url).toBe('http://host.docker.internal:3000/#/')
    // the fixture's `/admin/config` (excluded before) is now out of scope first; `/` is the seed
    expect(out.urls.map((u) => u.url)).toEqual([
      'http://localhost:3000/',
      'http://localhost:3000/api/Challenges/?name=Score%20Board',
      'http://localhost:3000/rest/products/search?q=',
      'http://localhost:3000/rest/basket/6',
    ])
    // scope is decided right after the origin: the asset, the two noise URLs and the
    // excluded `/admin/config` all count as outOfScope now, nothing else
    expect(out.meta).toMatchObject({
      dropped: { sameOriginOnly: 1, outOfScope: 4, asset: 0, noise: 0, excluded: 0 },
    })
  })

  it('with browser storage + several seeds: writes the selenium script 0600 for the run only, registers it, and crawls every seed', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    const workDir = join(tmp, 'work')
    const site = baseSite({
      discoverySeedPaths: '/#/\n/#/basket',
      browserStorage: [
        { kind: 'localStorage', name: 'token', value: 'eyJ.secret' },
        { kind: 'sessionStorage', name: 'bid', value: '6' },
      ],
      browserStorageNames: [
        { kind: 'localStorage', name: 'token' },
        { kind: 'sessionStorage', name: 'bid' },
      ],
    })

    const out = await runZapDiscover({
      discoveryId: 'disc-5',
      site,
      workDir,
      env,
      logger,
      signal: new AbortController().signal,
    })

    // secret script existed with mode 0600 while ZAP ran, and is gone afterwards
    expect(JSON.parse(readFileSync(join(workDir, 'secret-mode.json'), 'utf8'))).toBe(0o600)
    expect(existsSync(join(workDir, 'browser-storage.js'))).toBe(false)
    const plan: unknown = YAML.parse(readFileSync(join(workDir, 'plan.yaml'), 'utf8'))
    // as: see above
    const { jobs } = plan as PlanShape
    expect(jobs[1]?.parameters).toMatchObject({ action: 'add', type: 'selenium' })
    expect(jobs[1]?.parameters.file).toBe(join(workDir, 'browser-storage.js'))
    expect(jobs[2]?.parameters).toMatchObject({ action: 'enable', type: 'selenium' })
    expect(jobs.filter((j) => j.type === 'spiderAjax').map((j) => j.parameters.url)).toEqual([
      'http://localhost:3000/#/',
      'http://localhost:3000/#/basket',
    ])
    expect(out.meta).toMatchObject({
      seedUrls: ['http://localhost:3000/#/', 'http://localhost:3000/#/basket'],
      browserStorage: ['localStorage:token', 'sessionStorage:bid'],
    })
    // the secret value never reaches meta / warnings
    expect(JSON.stringify(out)).not.toContain('eyJ.secret')
  })

  it('throws EngineError when zap.sh produces no site-tree dump', async () => {
    const fakeBin = writeFakeZap(tmp, FIXTURE, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })
    process.env.FAKE_ZAP_NO_REPORT = '1'
    try {
      await expect(
        runZapDiscover({
          discoveryId: 'disc-3',
          site: baseSite(),
          workDir: join(tmp, 'work'),
          env,
          logger,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(EngineError)
    } finally {
      delete process.env.FAKE_ZAP_NO_REPORT
    }
  })

  it('warns when the Ajax spider ran but the app made no client-side API calls (SPA not started)', async () => {
    // type 2 = spider, type 10 = ajax. Ajax entries here are only an asset and
    // an HTML page — no API call — so the SPA-not-started warning must fire.
    const dump = join(tmp, 'no-api.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      dump,
      [
        JSON.stringify({ method: 'GET', url: 'http://localhost:3000/', type: 2, status: 200 }),
        JSON.stringify({
          method: 'GET',
          url: 'http://localhost:3000/_nuxt/entry.js',
          type: 10,
          status: 200,
        }),
        JSON.stringify({
          method: 'GET',
          url: 'http://localhost:3000/about',
          type: 10,
          status: 200,
        }),
      ].join('\n'),
    )
    const fakeBin = writeFakeZap(tmp, dump, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })

    const out = await runZapDiscover({
      discoveryId: 'disc-spa',
      site: baseSite(),
      workDir: join(tmp, 'work'),
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(out.warnings.some((w) => w.includes('made no client-side API calls'))).toBe(true)
    expect(out.meta.ajaxApiCallCount).toBe(0)
  })

  it('does not warn SPA-not-started when the client spider (type 24) made an API call', async () => {
    // type 10 = ajax (only an HTML page here), type 24 = client spider (an
    // API call). The client spider reaching the API means the SPA started, so
    // the warning must not fire even though no *ajax* entry is an API call.
    const dump = join(tmp, 'client-api.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      dump,
      [
        JSON.stringify({ method: 'GET', url: 'http://localhost:3000/', type: 2, status: 200 }),
        JSON.stringify({
          method: 'GET',
          url: 'http://localhost:3000/about',
          type: 10,
          status: 200,
        }),
        JSON.stringify({
          method: 'GET',
          url: 'http://localhost:3000/rest/products/search?q=',
          type: 24,
          status: 200,
        }),
      ].join('\n'),
    )
    const fakeBin = writeFakeZap(tmp, dump, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })

    const out = await runZapDiscover({
      discoveryId: 'disc-client',
      site: baseSite(),
      workDir: join(tmp, 'work'),
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(out.warnings.some((w) => w.includes('made no client-side API calls'))).toBe(false)
  })

  it('warns on a 401 but not on a 403 alone (403 is often legitimate access control)', async () => {
    const dump = join(tmp, 'forbidden.jsonl')
    const { writeFileSync } = await import('node:fs')
    // Only a 403 (a protected backup file) and a successful API call — no 401.
    writeFileSync(
      dump,
      [
        JSON.stringify({
          method: 'GET',
          url: 'http://localhost:3000/rest/products/search?q=',
          type: 10,
          status: 200,
        }),
        JSON.stringify({
          method: 'GET',
          url: 'http://localhost:3000/ftp/coupons.md.bak',
          type: 2,
          status: 403,
        }),
      ].join('\n'),
    )
    const fakeBin = writeFakeZap(tmp, dump, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })

    const out = await runZapDiscover({
      discoveryId: 'disc-403',
      site: baseSite(),
      workDir: join(tmp, 'work'),
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(out.warnings.some((w) => w.includes('Unauthorized'))).toBe(false)
    // the 403 is still recorded in meta, just not warned about as an auth failure
    expect(out.meta.authFailureCount).toBe(1)
  })

  it('keeps a GET and a POST of the same URL as two targets (method-aware dedupe)', async () => {
    const dump = join(tmp, 'methods.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      dump,
      [
        JSON.stringify({
          method: 'GET',
          url: 'http://localhost:3000/api/x',
          type: 10,
          status: 200,
        }),
        JSON.stringify({
          method: 'POST',
          url: 'http://localhost:3000/api/x',
          type: 10,
          status: 200,
        }),
        // a duplicate GET (different case) collapses into the first
        JSON.stringify({
          method: 'get',
          url: 'http://localhost:3000/api/x',
          type: 10,
          status: 200,
        }),
      ].join('\n'),
    )
    const fakeBin = writeFakeZap(tmp, dump, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })

    const out = await runZapDiscover({
      discoveryId: 'disc-methods',
      site: baseSite(),
      workDir: join(tmp, 'work'),
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(out.urls).toEqual([
      { url: 'http://localhost:3000/api/x', method: 'GET', statusCode: 200, source: 'ajax' },
      { url: 'http://localhost:3000/api/x', method: 'POST', statusCode: 200, source: 'ajax' },
    ])
  })

  it('warns when the crawl requested nothing at all', async () => {
    const empty = join(tmp, 'empty.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(empty, '')
    const fakeBin = writeFakeZap(tmp, empty, 'fake-zap.js', 'site-tree.jsonl')
    const env: Env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_ZAP_CMD: fakeBin,
      SAKUDA_DATA_DIR: tmp,
    })

    const out = await runZapDiscover({
      discoveryId: 'disc-4',
      site: baseSite(),
      workDir: join(tmp, 'work'),
      env,
      logger,
      signal: new AbortController().signal,
    })

    expect(out.urls).toEqual([])
    expect(out.warnings[0]).toContain('the crawl requested no URLs')
  })
})
