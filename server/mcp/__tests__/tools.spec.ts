import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { openDatabase } from '../../db/client'
import { engineRuns, findings, scans, sites } from '../../db/schema'
import { createSiteCipher } from '../../domain/headerCipher'
import { createScan } from '../../services/scanService'
import { createSite, loadSiteWithHeaders, type SiteServiceDeps } from '../../services/siteService'
import { AGENT_SITE_FIELDS, createSakudaMcpServer, type McpRequestContext } from '../tools'
import { SiteInputSchema, SiteUpdateSchema } from '#shared/schemas/site'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const TOKEN = 'tok-0123456789'
const STORAGE = 'stored-secret-value'
const timeBudgetEnv = {
  nucleiMaxMinutes: 60,
  httpxMaxMinutes: 5,
  dalfoxMaxMinutes: 10,
  engineGraceMinutes: 10,
}

let deps: SiteServiceDeps
let n = 0
let client: Client | undefined

beforeEach(() => {
  n = 0
  deps = {
    db: openDatabase({ file: ':memory:', migrationsFolder }),
    cipher: createSiteCipher(randomBytes(32).toString('base64')),
    now: () => new Date('2026-01-01T00:00:00Z'),
    id: () => `id-${++n}`,
  }
})

afterEach(async () => {
  await client?.close()
  client = undefined
})

async function connect(ctx: McpRequestContext = { authenticated: false }): Promise<Client> {
  const server = createSakudaMcpServer({ site: deps, timeBudgetEnv }, ctx)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await c.callTool({ name, arguments: args })
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? ''
  return { isError: res.isError === true, text, json: res.isError ? null : JSON.parse(text) }
}

/** A site with an Authorization header and a localStorage token, and one
 * finished scan whose single finding reflects both secrets. */
function seed() {
  const site = createSite(deps, {
    ...SiteInputSchema.parse({ name: 'shop', frontBaseUrl: 'http://localhost:3001/' }),
    headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
    browserStorage: [{ kind: 'localStorage', name: 'token', value: STORAGE }],
  })
  const scan = createScan(deps.db, deps, site.id, ['nuclei'])
  deps.db
    .update(scans)
    .set({ status: 'done', startedAt: scan.createdAt, finishedAt: scan.createdAt })
    .where(eq(scans.id, scan.id))
    .run()
  deps.db
    .insert(engineRuns)
    .values({
      id: 'run-1',
      scanId: scan.id,
      engine: 'nuclei',
      status: 'done',
      startedAt: scan.createdAt,
      finishedAt: scan.createdAt,
      exitCode: 0,
      signal: null,
      counts: { critical: 0, high: 1, medium: 1, low: 0, info: 0 },
      meta: {},
      warnings: [],
      error: null,
    })
    .run()
  const finding = (id: string, severity: 'high' | 'medium', evidence: string) => ({
    id,
    scanId: scan.id,
    engineRunId: 'run-1',
    engine: 'nuclei' as const,
    ruleId: `rule-${id}`,
    name: `finding ${id}`,
    severity,
    url: `http://localhost:3001/api?t=${TOKEN}`,
    method: 'GET',
    param: null,
    evidence,
    description: null,
    solution: null,
    reference: null,
    fingerprint: `fp-${id}`,
    raw: { token: TOKEN },
  })
  deps.db
    .insert(findings)
    .values([
      finding('f1', 'high', `echo Authorization: Bearer ${TOKEN} and ${STORAGE}`),
      finding('f2', 'medium', 'x'.repeat(3000)),
    ])
    .run()
  return { site, scan }
}

describe('sakuda MCP tools', () => {
  it('lists the five read-only tools and the six write tools', async () => {
    const c = await connect()
    const { tools } = await c.listTools()
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name)
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name)
    expect(readOnly.sort()).toEqual([
      'get_scan',
      'get_site',
      'list_findings',
      'list_scans',
      'list_sites',
    ])
    expect(writes.sort()).toEqual([
      'add_targets',
      'create_site',
      'set_finding_triage',
      'set_openapi',
      'start_scan',
      'update_site',
    ])
  })

  it('returns sites and scans without any secret value', async () => {
    const { site, scan } = seed()
    const c = await connect()

    const sites = await call(c, 'list_sites')
    expect(sites.json).toEqual([expect.objectContaining({ id: site.id, name: 'shop' })])

    const detail = await call(c, 'get_site', { siteId: site.id })
    expect(detail.json.headerNames).toEqual(['Authorization'])
    expect(detail.json).not.toHaveProperty('openapiJson')

    const scansList = await call(c, 'list_scans', { siteId: site.id })
    expect(scansList.json.map((s: { id: string }) => s.id)).toEqual([scan.id])

    const scanDetail = await call(c, 'get_scan', { scanId: scan.id })
    expect(scanDetail.json).toMatchObject({ id: scan.id, status: 'done', findingCount: 2 })
    expect(scanDetail.json).not.toHaveProperty('findings')

    for (const r of [sites, detail, scansList, scanDetail]) {
      expect(r.text).not.toContain(TOKEN)
      expect(r.text).not.toContain(STORAGE)
    }
  })

  it('redacts secrets in findings with labeled placeholders and wraps evidence as untrusted', async () => {
    const { scan } = seed()
    const c = await connect()
    const res = await call(c, 'list_findings', { scanId: scan.id })

    expect(res.text).not.toContain(TOKEN)
    expect(res.text).not.toContain(STORAGE)
    const [high, medium] = res.json.findings
    expect(high.evidence).toEqual({
      untrusted: true,
      source: 'target-response',
      text: 'echo Authorization: [SECRET:header:Authorization] and [SECRET:storage:localStorage:token]',
      truncated: false,
    })
    expect(high.url).toBe('http://localhost:3001/api?t=[SECRET:header:Authorization]')
    expect(high).not.toHaveProperty('raw')
    expect(medium.evidence.truncated).toBe(true)
  })

  it('filters by severity and pages with limit/offset', async () => {
    const { scan } = seed()
    const c = await connect()
    const medium = await call(c, 'list_findings', { scanId: scan.id, severity: 'medium' })
    expect(medium.json.total).toBe(1)
    expect(medium.json.findings[0].id).toBe('f2')

    const page = await call(c, 'list_findings', { scanId: scan.id, limit: 1, offset: 1 })
    expect(page.json).toMatchObject({ total: 2, offset: 1 })
    expect(page.json.findings.map((f: { id: string }) => f.id)).toEqual(['f2'])
  })

  it('reveal without authentication keeps placeholders and says why', async () => {
    const { scan } = seed()
    const c = await connect({ authenticated: false })
    const res = await call(c, 'list_findings', { scanId: scan.id, reveal: true })
    expect(res.text).not.toContain(TOKEN)
    expect(res.json.revealDenied).toMatch(/API key required/)
  })

  it('reveal with authentication returns the real values', async () => {
    const { scan } = seed()
    const c = await connect({ authenticated: true })
    const res = await call(c, 'list_findings', { scanId: scan.id, reveal: true })
    expect(res.text).toContain(TOKEN)
    expect(res.json).not.toHaveProperty('revealDenied')

    const hidden = await call(c, 'list_findings', { scanId: scan.id })
    expect(hidden.text).not.toContain(TOKEN)
  })

  it('reports unknown ids as tool errors', async () => {
    const c = await connect()
    expect(await call(c, 'get_site', { siteId: 'nope' })).toMatchObject({
      isError: true,
      text: 'site nope not found',
    })
    expect(await call(c, 'list_scans', { siteId: 'nope' })).toMatchObject({ isError: true })
    expect(await call(c, 'get_scan', { scanId: 'nope' })).toMatchObject({
      isError: true,
      text: 'scan nope not found',
    })
    expect(await call(c, 'list_findings', { scanId: 'nope' })).toMatchObject({ isError: true })
  })
})

describe('sakuda MCP write tools (#18)', () => {
  function plainSite(input: Record<string, unknown> = {}) {
    return createSite(
      deps,
      SiteInputSchema.parse({ name: 'shop', frontBaseUrl: 'http://localhost:3001/', ...input }),
    )
  }

  describe('add_targets', () => {
    it('appends lines and skips ones already saved, so re-sending is a no-op', async () => {
      const site = plainSite({ nucleiPaths: '/' })
      const c = await connect()
      const first = await call(c, 'add_targets', {
        siteId: site.id,
        lines: ['/api/products', 'POST /api/login'],
      })
      expect(first.json).toMatchObject({ added: ['/api/products', 'POST /api/login'], skipped: [] })
      const again = await call(c, 'add_targets', { siteId: site.id, lines: ['/api/products'] })
      expect(again.json).toMatchObject({ added: [], skipped: ['/api/products'] })
      expect(again.json.nucleiPaths).toBe(first.json.nucleiPaths)
    })

    it('rejects what the UI rejects, writing nothing', async () => {
      const site = plainSite({ nucleiPaths: '/' })
      const c = await connect()
      const bad = await call(c, 'add_targets', { siteId: site.id, lines: ['/ok', 'no-slash'] })
      expect(bad.isError).toBe(true)
      expect(bad.text).toMatch(/^VALIDATION: invalid target line\(s\): no-slash/)
      const apiLine = await call(c, 'add_targets', { siteId: site.id, lines: ['api:/x'] })
      expect(apiLine.text).toBe('VALIDATION: api: lines require apiBaseUrl to be set on the site')
      expect((await call(c, 'get_site', { siteId: site.id })).json.nucleiPaths).toBe('/')
      expect(await call(c, 'add_targets', { siteId: 'nope', lines: ['/x'] })).toMatchObject({
        isError: true,
        text: 'SITE_NOT_FOUND: site nope not found',
      })
    })
  })

  describe('set_openapi', () => {
    it('sets the URL or the JSON (clearing the other) and keeps settings and secrets', async () => {
      const { site } = seed()
      const c = await connect()
      const url = await call(c, 'set_openapi', {
        siteId: site.id,
        openapiUrl: 'http://localhost:3001/openapi.json/',
      })
      expect(url.json).toEqual({
        siteId: site.id,
        openapiUrl: 'http://localhost:3001/openapi.json',
        hasOpenapiJson: false,
      })
      const again = await call(c, 'set_openapi', {
        siteId: site.id,
        openapiUrl: 'http://localhost:3001/openapi.json',
      })
      expect(again.json).toEqual(url.json)

      const json = await call(c, 'set_openapi', { siteId: site.id, openapiJson: '{"openapi":"3"}' })
      expect(json.json).toEqual({ siteId: site.id, openapiUrl: null, hasOpenapiJson: true })

      const stored = loadSiteWithHeaders(deps, site.id)
      expect(stored?.headers).toEqual([{ name: 'Authorization', value: `Bearer ${TOKEN}` }])
      expect(stored?.browserStorage).toEqual([
        { kind: 'localStorage', name: 'token', value: STORAGE },
      ])
      expect(stored?.name).toBe('shop')
    })

    it('runs the same validation as the edit form', async () => {
      const site = plainSite()
      const c = await connect()
      const set = (args: Record<string, unknown>) =>
        call(c, 'set_openapi', { siteId: site.id, ...args })

      expect((await set({})).text).toBe('VALIDATION: pass exactly one of openapiUrl or openapiJson')
      expect((await set({ openapiUrl: 'http://localhost/a', openapiJson: '{}' })).text).toBe(
        'VALIDATION: pass exactly one of openapiUrl or openapiJson',
      )
      expect((await set({ openapiUrl: 'ftp://localhost/a' })).text).toBe(
        'VALIDATION: openapiUrl: must be an http(s) URL',
      )
      expect((await set({ openapiJson: '[1' })).text).toBe(
        'VALIDATION: openapiJson: openapiJson must be a JSON object',
      )
      // An agent cannot confirm a non-local target on the user's behalf.
      const nonLocal = await set({ openapiUrl: 'https://api.example.com/openapi.json' })
      expect(nonLocal.isError).toBe(true)
      expect(nonLocal.text).toContain('nonLocalConfirmed')
      expect((await call(c, 'get_site', { siteId: site.id })).json.openapiUrl).toBeNull()
      expect(
        await call(c, 'set_openapi', { siteId: 'nope', openapiUrl: 'http://localhost/a' }),
      ).toMatchObject({ isError: true, text: 'site nope not found' })
    })

    it('keeps a non-local URL on the origins the user confirmed', async () => {
      const site = plainSite({
        frontBaseUrl: 'https://shop.example.com',
        apiBaseUrl: 'https://api.example.com/v1',
        nonLocalConfirmed: true,
      })
      const c = await connect()
      const set = (openapiUrl: string) => call(c, 'set_openapi', { siteId: site.id, openapiUrl })

      expect((await set('https://api.example.com/openapi.json')).json.openapiUrl).toBe(
        'https://api.example.com/openapi.json',
      )
      expect((await set('https://shop.example.com/spec.json')).isError).toBe(false)
      expect((await set('http://localhost:3001/openapi.json')).isError).toBe(false)
      const elsewhere = await set('https://other.example.net/openapi.json')
      expect(elsewhere.isError).toBe(true)
      expect(elsewhere.text).toMatch(/^OPENAPI_HOST_NOT_CONFIRMED: /)
      expect((await call(c, 'get_site', { siteId: site.id })).json.openapiUrl).toBe(
        'http://localhost:3001/openapi.json',
      )
    })
  })

  describe('start_scan', () => {
    it('queues a scan through the same gates as the UI and returns refusals with a reason', async () => {
      const site = plainSite()
      const c = await connect()

      const prereq = await call(c, 'start_scan', { siteId: site.id, engines: ['zap-api'] })
      expect(prereq).toMatchObject({
        isError: true,
        text: 'ENGINE_PREREQ: zap-api requires openapiUrl or openapiJson',
      })

      const started = await call(c, 'start_scan', {
        siteId: site.id,
        engines: ['nuclei', 'nuclei'],
      })
      expect(started.json).toMatchObject({
        siteId: site.id,
        status: 'queued',
        engines: ['nuclei'],
        warnings: [],
      })

      expect(await call(c, 'start_scan', { siteId: site.id, engines: ['nuclei'] })).toMatchObject({
        isError: true,
        text: `SCAN_ACTIVE: site ${site.id} already has an active scan`,
      })
      expect(await call(c, 'start_scan', { siteId: 'nope', engines: ['nuclei'] })).toMatchObject({
        isError: true,
        text: 'SITE_NOT_FOUND: site nope not found',
      })
    })

    it('refuses a non-local site that has not been confirmed', async () => {
      const site = plainSite()
      deps.db
        .update(sites)
        .set({ frontBaseUrl: 'https://shop.example.com' })
        .where(eq(sites.id, site.id))
        .run()
      const c = await connect()
      expect(await call(c, 'start_scan', { siteId: site.id, engines: ['nuclei'] })).toMatchObject({
        isError: true,
        text: 'NON_LOCAL_UNCONFIRMED: site targets a non-local host without confirmation',
      })
    })
  })

  describe('set_finding_triage', () => {
    it('stores the verdict, shows it in reads and drops it from the new findings', async () => {
      const { scan } = seed()
      const c = await connect()
      const set = await call(c, 'set_finding_triage', {
        findingId: 'f1',
        status: 'false-positive',
        reason: 'the header is echoed by our own debug endpoint',
      })
      expect(set.json).toMatchObject({
        fingerprint: 'fp-f1',
        triage: {
          status: 'false-positive',
          reason: 'the header is echoed by our own debug endpoint',
        },
      })
      const again = await call(c, 'set_finding_triage', {
        findingId: 'f1',
        status: 'false-positive',
        reason: 'the header is echoed by our own debug endpoint',
      })
      expect(again.json).toEqual(set.json)

      const onlyNew = await call(c, 'list_findings', { scanId: scan.id, onlyNew: true })
      expect(onlyNew.json.findings.map((f: { id: string }) => f.id)).toEqual(['f2'])
      const all = await call(c, 'list_findings', { scanId: scan.id })
      expect(all.json.findings[0]).toMatchObject({
        id: 'f1',
        isNew: false,
        triage: { status: 'false-positive' },
      })
    })

    it('rejects an unknown finding, an unknown status and an empty reason', async () => {
      seed()
      const c = await connect()
      expect(
        await call(c, 'set_finding_triage', { findingId: 'nope', status: 'accepted', reason: 'r' }),
      ).toMatchObject({ isError: true, text: 'FINDING_NOT_FOUND: finding nope not found' })
      expect(
        (await call(c, 'set_finding_triage', { findingId: 'f1', status: 'wontfix', reason: 'r' }))
          .isError,
      ).toBe(true)
      expect(
        (await call(c, 'set_finding_triage', { findingId: 'f1', status: 'accepted', reason: ' ' }))
          .isError,
      ).toBe(true)
    })
  })
})

describe('sakuda MCP site write tools (#46)', () => {
  const UI_ONLY = ['nonLocalConfirmed', 'allowMutatingRequests', 'nucleiEnabledRiskTags']

  it('offers every site field except the UI-only ones', () => {
    const formFields = Object.keys(SiteUpdateSchema.shape).filter((k) => !UI_ONLY.includes(k))
    expect(Object.keys(AGENT_SITE_FIELDS).sort()).toEqual(formFields.sort())
  })

  describe('create_site', () => {
    it('creates a site that list_sites and get_site show, with secrets by name only', async () => {
      const c = await connect()
      const created = await call(c, 'create_site', {
        name: 'shop',
        frontBaseUrl: 'http://localhost:3001/',
        nucleiPaths: '/api/products',
        headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
        browserStorage: [{ kind: 'cookie', name: 'token', value: STORAGE }],
      })
      expect(created.isError).toBe(false)
      expect(created.text).not.toContain(TOKEN)
      expect(created.text).not.toContain(STORAGE)
      expect(created.json).toMatchObject({
        name: 'shop',
        frontBaseUrl: 'http://localhost:3001',
        nucleiPaths: '/api/products',
        headerNames: ['Authorization'],
        nonLocalConfirmed: false,
        allowMutatingRequests: false,
      })

      const got = await call(c, 'get_site', { siteId: created.json.id })
      expect(got.json).toEqual(created.json)
      const listed = await call(c, 'list_sites')
      expect(listed.json.map((s: { id: string }) => s.id)).toEqual([created.json.id])
      expect(loadSiteWithHeaders(deps, created.json.id)?.headers).toEqual([
        { name: 'Authorization', value: `Bearer ${TOKEN}` },
      ])
    })

    it('rejects what POST /api/sites rejects, with the same VALIDATION code', async () => {
      const c = await connect()
      expect(
        (await call(c, 'create_site', { frontBaseUrl: 'http://localhost:3001' })).text,
      ).toMatch(/^VALIDATION: name: /)
      expect(
        (await call(c, 'create_site', { name: 'x', frontBaseUrl: 'ftp://localhost' })).text,
      ).toBe('VALIDATION: frontBaseUrl: must be an http(s) URL')
      const noValue = await call(c, 'create_site', {
        name: 'x',
        frontBaseUrl: 'http://localhost:3001',
        headers: [{ name: 'Authorization' }],
      })
      expect(noValue.text).toMatch(/^VALIDATION: headers\.0\.value: /)
      expect((await call(c, 'list_sites')).json).toEqual([])
    })

    it('refuses a non-local target and the UI-only settings', async () => {
      const c = await connect()
      const nonLocal = await call(c, 'create_site', {
        name: 'x',
        frontBaseUrl: 'https://shop.example.com',
      })
      expect(nonLocal.isError).toBe(true)
      expect(nonLocal.text).toMatch(/^NON_LOCAL_REQUIRES_UI: /)
      for (const [key, value] of [
        ['nonLocalConfirmed', true],
        ['allowMutatingRequests', true],
        ['nucleiEnabledRiskTags', ['dos']],
      ] as const) {
        const res = await call(c, 'create_site', {
          name: 'x',
          frontBaseUrl: 'https://shop.example.com',
          [key]: value,
        })
        expect(res.isError).toBe(true)
        expect(res.text).toContain(key)
      }
      expect((await call(c, 'list_sites')).json).toEqual([])
    })
  })

  describe('update_site', () => {
    it('changes only the passed fields and keeps secrets unless they are passed', async () => {
      const { site } = seed()
      const c = await connect()
      const before = (await call(c, 'get_site', { siteId: site.id })).json
      const updated = await call(c, 'update_site', {
        siteId: site.id,
        name: 'shop v2',
        nucleiRateLimit: 10,
      })
      expect(updated.json).toEqual({ ...before, name: 'shop v2', nucleiRateLimit: 10 })
      expect(updated.text).not.toContain(TOKEN)
      expect(loadSiteWithHeaders(deps, site.id)?.headers).toEqual([
        { name: 'Authorization', value: `Bearer ${TOKEN}` },
      ])

      // A row without value keeps the stored one; a new value replaces it.
      await call(c, 'update_site', {
        siteId: site.id,
        headers: [{ name: 'Authorization' }, { name: 'X-Api-Key', value: 'k-0123456789' }],
      })
      expect(loadSiteWithHeaders(deps, site.id)?.headers).toEqual([
        { name: 'Authorization', value: `Bearer ${TOKEN}` },
        { name: 'X-Api-Key', value: 'k-0123456789' },
      ])
      const read = await call(c, 'get_site', { siteId: site.id })
      expect(read.text).not.toContain('k-0123456789')
      expect(read.json.headerNames).toEqual(['Authorization', 'X-Api-Key'])
    })

    it('rejects invalid input and unknown sites, writing nothing', async () => {
      const site = createSite(
        deps,
        SiteInputSchema.parse({ name: 'shop', frontBaseUrl: 'http://localhost:3001' }),
      )
      const c = await connect()
      expect(
        (await call(c, 'update_site', { siteId: site.id, nucleiPaths: 'api:/x' })).text,
      ).toMatch(/^VALIDATION: apiBaseUrl: /)
      expect((await call(c, 'update_site', { siteId: site.id, name: '' })).text).toMatch(
        /^VALIDATION: name: /,
      )
      expect(await call(c, 'update_site', { siteId: 'nope', name: 'x' })).toMatchObject({
        isError: true,
        text: 'SITE_NOT_FOUND: site nope not found',
      })
      const res = await call(c, 'update_site', { siteId: site.id, allowMutatingRequests: true })
      expect(res.isError).toBe(true)
      expect(res.text).toContain('allowMutatingRequests')
      expect((await call(c, 'get_site', { siteId: site.id })).json).toMatchObject({
        name: 'shop',
        nucleiPaths: '',
        allowMutatingRequests: false,
      })
    })

    it('keeps non-local URLs on the origins the user confirmed', async () => {
      const local = createSite(
        deps,
        SiteInputSchema.parse({ name: 'local', frontBaseUrl: 'http://localhost:3001' }),
      )
      const remote = createSite(
        deps,
        SiteInputSchema.parse({
          name: 'remote',
          frontBaseUrl: 'https://shop.example.com',
          nonLocalConfirmed: true,
        }),
      )
      const c = await connect()
      const toRemote = await call(c, 'update_site', {
        siteId: local.id,
        frontBaseUrl: 'https://shop.example.com',
      })
      expect(toRemote.text).toMatch(/^NON_LOCAL_REQUIRES_UI: /)

      expect(
        (
          await call(c, 'update_site', {
            siteId: remote.id,
            apiBaseUrl: 'https://shop.example.com/api',
          })
        ).json.apiBaseUrl,
      ).toBe('https://shop.example.com/api')
      const elsewhere = await call(c, 'update_site', {
        siteId: remote.id,
        apiBaseUrl: 'https://api.other.example.net',
      })
      expect(elsewhere.text).toMatch(/^HOST_NOT_CONFIRMED: https:\/\/api\.other\.example\.net /)
      expect((await call(c, 'get_site', { siteId: remote.id })).json.apiBaseUrl).toBe(
        'https://shop.example.com/api',
      )
    })
  })
})
