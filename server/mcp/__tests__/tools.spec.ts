import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { openDatabase } from '../../db/client'
import { engineRuns, findings, scans } from '../../db/schema'
import { createSiteCipher } from '../../domain/headerCipher'
import { createScan } from '../../services/scanService'
import { createSite, type SiteServiceDeps } from '../../services/siteService'
import { createSakudaMcpServer, type McpRequestContext } from '../tools'
import { SiteInputSchema } from '#shared/schemas/site'

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
  it('lists the five read-only tools', async () => {
    const c = await connect()
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_scan',
      'get_site',
      'list_findings',
      'list_scans',
      'list_sites',
    ])
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
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
