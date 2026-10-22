import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseEnv, type Env } from '../../../config/env'
import type { SiteWithHeaders } from '../../../services/siteService'
import { EngineError } from '../../types'
import { runBoundary } from '../index'

interface Seen {
  method: string
  url: string
  authorization: string | undefined
  body: string
}

const key = randomBytes(32).toString('base64')
const logger = pino({ level: 'silent' })

let server: Server
let origin: string
let seen: Seen[]
const stored = new Map<string, Record<string, unknown>>()

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const chunk of req) data += String(chunk)
  return data
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req)
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      })
      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(payload))
      }
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      // /lax: stores whatever it gets and echoes it (no server-side validation).
      if (req.method === 'POST' && req.url === '/lax') return json(201, { id: 1, ...parsed })
      // /strict: enforces the documented range, rejects with 400.
      if (req.method === 'POST' && req.url === '/strict') {
        const age = parsed.age
        if (typeof age !== 'number' || age < 0 || age > 120) return json(400, { error: 'age' })
        return json(201, { id: 2, ...parsed })
      }
      // /coerce: casts to the declared type, so "abc" becomes 0.
      if (req.method === 'POST' && req.url === '/coerce')
        return json(201, { id: 3, age: Number(parsed.age) || 0 })
      // /located: empty 201 with Location; the resource is readable by GET.
      if (req.method === 'POST' && req.url === '/located') {
        stored.set('/located/1', parsed)
        res.writeHead(201, { location: '/located/1' })
        return res.end()
      }
      if (req.method === 'GET' && stored.has(req.url ?? '')) return json(200, stored.get(req.url!))
      // /huge: a body far over the read cap; the engine must not buffer it whole.
      if (req.method === 'POST' && req.url === '/huge') {
        res.writeHead(201, { 'content-type': 'application/json' })
        return res.end(`{"pad":"${'x'.repeat(5_000_000)}"}`)
      }
      // /offsite: Location on another origin must never be followed.
      if (req.method === 'POST' && req.url === '/offsite') {
        res.writeHead(201, { location: 'http://other.invalid/x' })
        return res.end()
      }
      json(404, {})
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
beforeEach(() => {
  seen = []
  stored.clear()
})

const openapi = (path: string) =>
  JSON.stringify({
    openapi: '3.0.0',
    paths: {
      [path]: {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['age'],
                  properties: { age: { type: 'integer', minimum: 0, maximum: 120 } },
                },
              },
            },
          },
        },
      },
    },
  })

function baseSite(overrides: Partial<SiteWithHeaders> = {}): SiteWithHeaders {
  return {
    id: 'site-1',
    name: 'shop',
    frontBaseUrl: origin,
    apiBaseUrl: null,
    nucleiPaths: '',
    openapiUrl: null,
    openapiJson: openapi('/lax'),
    zapFeSeedPath: '/',
    discoverySeedPaths: '',
    crawlScopePaths: '',
    excludePaths: '',
    nucleiRateLimit: 0,
    zapApiMaxMinutes: 45,
    zapFeSpiderMaxMinutes: 5,
    nonLocalConfirmed: false,
    allowMutatingRequests: true,
    nucleiEnabledRiskTags: [],
    headerNames: [],
    browserStorageNames: [],
    requiresConfirmation: false,
    requestShapes: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    headers: [],
    browserStorage: [],
    ...overrides,
  }
}

const env = (extra: Record<string, string> = {}): Env =>
  parseEnv({ SAKUDA_ENCRYPTION_KEY: key, ...extra } as NodeJS.ProcessEnv)

const run = (site: SiteWithHeaders, e: Env = env(), signal = new AbortController().signal) =>
  runBoundary({
    scanId: 'scan-1',
    engine: 'boundary',
    site,
    workDir: '/unused',
    env: e,
    logger,
    signal,
  })

describe('runBoundary', () => {
  it('skips (not fails) and sends nothing when active checks are off', async () => {
    const out = await run(baseSite({ allowMutatingRequests: false }))
    expect(out.skipped).toBe(true)
    expect(out.meta.reason).toBe('active-checks-off')
    expect(seen).toHaveLength(0)
  })

  it('reports a finding when out-of-range values are stored as sent', async () => {
    const out = await run(baseSite())
    const kinds = out.findings.map((f) => f.ruleId).sort()
    expect(kinds).toEqual([
      'boundary:above-maximum',
      'boundary:below-minimum',
      'boundary:wrong-type',
    ])
    const above = out.findings.find((f) => f.ruleId === 'boundary:above-maximum')!
    expect(above).toMatchObject({
      engine: 'boundary',
      severity: 'medium',
      method: 'POST',
      param: 'age',
      url: `${origin}/lax`,
    })
    expect(above.evidence).toContain('age=121')
    expect(out.counts.medium).toBe(3)
    expect(out.meta.accepted).toBe(3)
  })

  it('reports nothing when the server rejects with 4xx', async () => {
    const out = await run(baseSite({ openapiJson: openapi('/strict') }))
    expect(out.findings).toHaveLength(0)
    expect(out.meta).toMatchObject({ accepted: 0, rejected: 3 })
  })

  it('does not report a type-coerced value as accepted', async () => {
    const out = await run(baseSite({ openapiJson: openapi('/coerce') }))
    // "abc" → 0 and 12345-style casts are the server converting, not storing
    // the bad value; the genuine range violations (-1, 121) are still caught.
    expect(out.findings.map((f) => f.ruleId)).not.toContain('boundary:wrong-type')
    expect(out.meta.coerced).toBeGreaterThan(0)
  })

  it('reads the stored value back through Location', async () => {
    const out = await run(baseSite({ openapiJson: openapi('/located') }))
    expect(out.findings.length).toBeGreaterThan(0)
    expect(out.findings[0]!.evidence).toContain('Location resource')
    expect(seen.some((s) => s.method === 'GET' && s.url === '/located/1')).toBe(true)
  })

  it('counts a 2xx it cannot read back as unverifiable, with a warning, not a finding', async () => {
    const out = await run(baseSite({ openapiJson: openapi('/offsite') }))
    expect(out.findings).toHaveLength(0)
    expect(out.meta.unverifiable).toBe(3)
    expect(out.warnings.join(' ')).toMatch(/could not be read back/)
    expect(seen.every((s) => s.method === 'POST')).toBe(true)
  })

  it('survives a response far larger than the read cap, as unverifiable', async () => {
    const out = await run(baseSite({ openapiJson: openapi('/huge') }))
    expect(out.findings).toHaveLength(0)
    expect(out.meta.unverifiable).toBe(3)
  })

  it('stops at the request cap and says so', async () => {
    const out = await run(baseSite(), env({ SAKUDA_BOUNDARY_MAX_REQUESTS: '2' }))
    expect(seen).toHaveLength(2)
    expect(out.meta).toMatchObject({ requestsSent: 2, truncated: true })
    expect(out.warnings.join(' ')).toMatch(/stopped early/)
  })

  it('sends the site headers but never exposes them in the output', async () => {
    const out = await run(
      baseSite({ headers: [{ name: 'Authorization', value: 'Bearer s3cr3t-token' }] }),
    )
    expect(seen.every((s) => s.authorization === 'Bearer s3cr3t-token')).toBe(true)
    expect(JSON.stringify(out)).not.toContain('s3cr3t-token')
  })

  it('probes shape-captured write lines with type confusion only', async () => {
    const out = await run(
      baseSite({
        openapiJson: null,
        nucleiPaths: 'POST /lax',
        requestShapes: {
          'POST|front|/lax': {
            contentType: 'application/json',
            bodyShape: {
              kind: 'json',
              root: { type: 'object', fields: { title: { type: 'string' } } },
            },
          },
        },
      }),
    )
    expect(out.findings.map((f) => f.ruleId).sort()).toEqual([
      'boundary:empty',
      'boundary:wrong-type',
    ])
  })

  it('warns that an OpenAPI URL alone only allows type and empty probes', async () => {
    const out = await run(
      baseSite({
        openapiJson: null,
        openapiUrl: `${origin}/openapi.json`,
        nucleiPaths: 'POST /lax',
        requestShapes: {
          'POST|front|/lax': {
            contentType: 'application/json',
            bodyShape: {
              kind: 'json',
              root: { type: 'object', fields: { title: { type: 'string' } } },
            },
          },
        },
      }),
    )
    expect(out.meta.openapiUrlOnly).toBe(true)
    expect(out.warnings.join(' ')).toMatch(/OpenAPI URL/)
    expect(seen.some((s) => s.url === '/openapi.json')).toBe(false)
  })

  it('fails with a runbook message when there is nothing to send', async () => {
    await expect(run(baseSite({ openapiJson: null }))).rejects.toThrow(EngineError)
  })

  it('fails loudly when the target is unreachable instead of reporting a clean run', async () => {
    const site = baseSite({ frontBaseUrl: 'http://127.0.0.1:1', openapiJson: openapi('/lax') })
    await expect(run(site)).rejects.toThrow(/every request failed/)
  })
})
