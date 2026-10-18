import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetch, setup, url } from '@nuxt/test-utils/e2e'
import { afterAll, describe, expect, it } from 'vitest'

// Must be set before `setup()` boots the server subprocess: it inherits
// process.env, and the app validates these at startup (server/config/env.ts).
process.env.SAKUDA_ENCRYPTION_KEY = randomBytes(32).toString('base64')
const dataDir = await mkdtemp(join(tmpdir(), 'sakuda-e2e-'))
process.env.SAKUDA_DATA_DIR = dataDir
// Keep the queue from ever running a real scan — these tests only assert on
// API-level state transitions (queued/409/etc.), not engine execution.
process.env.SAKUDA_JOB_RUNNER = 'off'
// Auth capture must never reach a real Chrome a developer may have running on
// :9222 — point it at a port nothing listens on (#17).
process.env.SAKUDA_CAPTURE_CDP_URL = 'http://127.0.0.1:9'
// One extra hostname for the `/api/**` guard, to prove the list works and
// that `/mcp` ignores it (#22).
process.env.SAKUDA_ALLOWED_HOSTS = 'sakuda.lan'

await setup({ server: true })

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function requireId(v: unknown): string {
  if (!isRecord(v) || typeof v.id !== 'string')
    throw new Error(`expected an object with id, got ${JSON.stringify(v)}`)
  return v.id
}

/** Sends a request with headers `fetch` refuses to set (`Host`). */
function rawRequest(
  path: string,
  method: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(url('/'))
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout: ${method} ${path}`)))
    req.end()
  })
}

const METHODS = new Set(['get', 'post', 'put', 'delete', 'patch'])

/** Every `/api/**` route, read from the file tree so a new route is covered
 * without editing this test: `sites/[id]/scans.post.ts` → `POST
 * /api/sites/x/scans`. */
function apiRoutes(): { method: string; path: string }[] {
  const apiDir = fileURLToPath(new URL('../../server/api', import.meta.url))
  return readdirSync(apiDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => {
      const parts = relative(apiDir, join(e.parentPath, e.name)).split('/')
      const segments = (parts.pop() ?? '').replace(/\.ts$/, '').split('.')
      const method = METHODS.has(segments.at(-1) ?? '') ? (segments.pop() ?? 'get') : 'get'
      const name = segments.join('.')
      if (name !== 'index') parts.push(name)
      const path = '/api/' + parts.map((p) => p.replace(/^\[.+\]$/, 'x')).join('/')
      return { method: method.toUpperCase(), path }
    })
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('api e2e', () => {
  const cookieValue = 'super-secret-cookie-value-123456'
  let siteId: string
  let scanId: string

  it('POST /api/sites creates a site and never echoes header values', async () => {
    const res = await postJson('/api/sites', {
      name: 'Local target',
      frontBaseUrl: 'http://localhost:39991',
      nucleiPaths: '/',
      headers: [{ name: 'Cookie', value: cookieValue }],
    })
    expect(res.status).toBe(201)
    const site: unknown = await res.json()
    expect(site).toMatchObject({ headerNames: ['Cookie'] })
    expect(JSON.stringify(site)).not.toContain(cookieValue)
    siteId = requireId(site)
  })

  it('GET /api/sites lists the created site with no scan yet', async () => {
    const res = await fetch('/api/sites')
    expect(res.status).toBe(200)
    const sites: unknown = await res.json()
    expect(Array.isArray(sites)).toBe(true)
    expect(sites).toHaveLength(1)
    expect(sites).toMatchObject([{ id: siteId, lastScan: null }])
  })

  it('POST /api/sites/:id/scans queues a nuclei-only scan', async () => {
    const res = await postJson(`/api/sites/${siteId}/scans`, { engines: ['nuclei'] })
    expect(res.status).toBe(202)
    const scan: unknown = await res.json()
    expect(scan).toMatchObject({ status: 'queued', warnings: [] })
    scanId = requireId(scan)
  })

  it('a second POST while one is active is rejected', async () => {
    const res = await postJson(`/api/sites/${siteId}/scans`, { engines: ['nuclei'] })
    expect(res.status).toBe(409)
  })

  it('GET /api/scans/:id reports queued status', async () => {
    const res = await fetch(`/api/scans/${scanId}`)
    expect(res.status).toBe(200)
    const scan: unknown = await res.json()
    expect(scan).toMatchObject({ status: 'queued' })
  })

  it('GET /api/jobs lists the queued scan with its kind, site, and engines', async () => {
    const res = await fetch('/api/jobs')
    expect(res.status).toBe(200)
    const list: unknown = await res.json()
    expect(list).toMatchObject([
      {
        kind: 'scan',
        status: 'queued',
        id: scanId,
        siteId,
        siteName: 'Local target',
        engines: ['nuclei'],
      },
    ])
  })

  it('GET /api/scans/:id/report.md is rejected before the scan finishes', async () => {
    const res = await fetch(`/api/scans/${scanId}/report.md`)
    expect(res.status).toBe(409)
  })

  it('POST /api/sites/:id/discoveries is rejected while a scan is active', async () => {
    const res = await postJson(`/api/sites/${siteId}/discoveries`, {})
    expect(res.status).toBe(409)
  })

  it('POST /api/sites/:id/targets appends new target lines, skipping ones already saved', async () => {
    const res = await postJson(`/api/sites/${siteId}/targets`, {
      lines: ['/', '/rest/products/search?q=', '/login'],
    })
    expect(res.status).toBe(200)
    const body: unknown = await res.json()
    expect(body).toMatchObject({
      added: ['/rest/products/search?q=', '/login'],
      skipped: ['/'],
      site: { id: siteId, nucleiPaths: '/\n/rest/products/search?q=\n/login\n' },
    })

    const site = await fetch(`/api/sites/${siteId}`)
    expect(await site.json()).toMatchObject({
      nucleiPaths: '/\n/rest/products/search?q=\n/login\n',
    })
  })

  it('POST /api/sites/:id/targets rejects invalid lines with 422 and changes nothing', async () => {
    const res = await postJson(`/api/sites/${siteId}/targets`, {
      lines: ['/ok', 'http://absolute.example/x'],
    })
    expect(res.status).toBe(422)
    const site = await fetch(`/api/sites/${siteId}`)
    expect(await site.json()).toMatchObject({
      nucleiPaths: '/\n/rest/products/search?q=\n/login\n',
    })
  })

  it('DELETE /api/sites/:id/targets removes one saved line, idempotently', async () => {
    const del = (line: string) =>
      fetch(`/api/sites/${siteId}/targets`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ line }),
      })
    const res = await del('/login')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      removed: true,
      site: { id: siteId, nucleiPaths: '/\n/rest/products/search?q=\n' },
    })
    const again = await del('/login')
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ removed: false })
    const site = await fetch(`/api/sites/${siteId}`)
    expect(await site.json()).toMatchObject({ nucleiPaths: '/\n/rest/products/search?q=\n' })
  })

  it('GET /api/sites/:id/targets summarizes the saved list per engine, paths only', async () => {
    const res = await fetch(`/api/sites/${siteId}/targets`)
    expect(res.status).toBe(200)
    const body: unknown = await res.json()
    expect(body).toMatchObject({
      configured: true,
      activeChecks: false,
      common: [
        { method: 'GET', base: 'front', path: '/' },
        { method: 'GET', base: 'front', path: '/rest/products/search?q=' },
      ],
      engines: { nuclei: { available: true }, dalfox: { available: false, targets: [] } },
      zapApiSource: 'none',
    })
    expect(JSON.stringify(body)).not.toContain('localhost')
    const missing = await fetch('/api/sites/nope/targets')
    expect(missing.status).toBe(404)
  })

  it('GET /api/sites/:id/discoveries lists nothing for a site that never discovered', async () => {
    const res = await fetch(`/api/sites/${siteId}/discoveries`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('discovery flow on a fresh site: POST queues, GET detail reports queued, second POST is 409', async () => {
    const created = await postJson('/api/sites', {
      name: 'Discovery target',
      frontBaseUrl: 'http://localhost:39993',
    })
    expect(created.status).toBe(201)
    const otherSiteId = requireId(await created.json())

    const res = await postJson(`/api/sites/${otherSiteId}/discoveries`, {})
    expect(res.status).toBe(202)
    const discovery: unknown = await res.json()
    expect(discovery).toMatchObject({ siteId: otherSiteId, status: 'queued', urlCount: 0 })
    const discoveryId = requireId(discovery)

    const detail = await fetch(`/api/discoveries/${discoveryId}`)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ id: discoveryId, status: 'queued', urls: [] })

    const list = await fetch(`/api/sites/${otherSiteId}/discoveries`)
    expect(await list.json()).toMatchObject([{ id: discoveryId }])

    expect((await postJson(`/api/sites/${otherSiteId}/discoveries`, {})).status).toBe(409)
    // and a scan must wait for the discovery too
    expect(
      (await postJson(`/api/sites/${otherSiteId}/scans`, { engines: ['nuclei'] })).status,
    ).toBe(409)
  })

  it('browserStorage is write-only: names come back, values never do; bad seed lines are 422', async () => {
    const secret = 'eyJ-super-secret-token-value'
    const res = await postJson('/api/sites', {
      name: 'SPA target',
      frontBaseUrl: 'http://localhost:39994',
      discoverySeedPaths: '/#/\n/#/basket',
      browserStorage: [
        { kind: 'localStorage', name: 'token', value: secret },
        { kind: 'sessionStorage', name: 'bid', value: '6' },
      ],
    })
    expect(res.status).toBe(201)
    const site: unknown = await res.json()
    expect(site).toMatchObject({
      discoverySeedPaths: '/#/\n/#/basket',
      browserStorageNames: [
        { kind: 'localStorage', name: 'token' },
        { kind: 'sessionStorage', name: 'bid' },
      ],
    })
    expect(JSON.stringify(site)).not.toContain(secret)
    const again = await fetch(`/api/sites/${requireId(site)}`)
    expect(JSON.stringify(await again.json())).not.toContain(secret)

    const bad = await postJson('/api/sites', {
      name: 'Bad seeds',
      frontBaseUrl: 'http://localhost:39995',
      discoverySeedPaths: 'http://absolute.example/',
    })
    expect(bad.status).toBe(422)
    expect(JSON.stringify(await bad.json())).toContain('discoverySeedPaths')
  })

  it('POST /api/sites with a non-JSON content-type is rejected with 415 (I7)', async () => {
    const res = await fetch('/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        name: 'Cross-origin form',
        frontBaseUrl: 'http://localhost:39992',
        nucleiPaths: '/',
      }),
    })
    expect(res.status).toBe(415)
  })

  it('a non-local site without nonLocalConfirmed is rejected with a nonLocalConfirmed issue', async () => {
    const res = await postJson('/api/sites', {
      name: 'Remote target',
      frontBaseUrl: 'https://example.com',
      nucleiPaths: '/',
    })
    expect(res.status).toBe(422)
    const body: unknown = await res.json()
    expect(JSON.stringify(body)).toContain('nonLocalConfirmed')
  })

  it('GET /api/sites/:id/secrets returns values to loopback only, never cached (#17)', async () => {
    const res = await fetch(`/api/sites/${siteId}/secrets`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      headers: [{ name: 'Cookie', value: cookieValue }],
      browserStorage: expect.any(Array),
    })

    // A foreign Host on every route is covered by 'api loopback guard (#22)'.
    const crossOrigin = await fetch(`/api/sites/${siteId}/secrets`, {
      headers: { origin: 'https://evil.example' },
    })
    expect(crossOrigin.status).toBe(403)
    expect(JSON.stringify(await crossOrigin.json())).not.toContain(cookieValue)
  })

  it('capture routes are loopback-only and report a missing capture browser as 503 (#17)', async () => {
    const foreign = await fetch(`/api/sites/${siteId}/capture/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    })
    expect(foreign.status).toBe(403)

    const start = await postJson(`/api/sites/${siteId}/capture/start`, {})
    expect(start.status).toBe(503)
    expect(JSON.stringify(await start.json())).toContain('make capture-browser')

    const badId = await postJson(`/api/sites/${siteId}/capture`, { targetId: '../json/version' })
    expect(badId.status).toBe(422)
  })
})

describe('api loopback guard (#22)', () => {
  const routes = apiRoutes()

  it('finds the API routes from the file tree', () => {
    expect(routes.length).toBeGreaterThanOrEqual(25)
    expect(routes).toContainEqual({ method: 'POST', path: '/api/sites/x/scans' })
    expect(routes).toContainEqual({ method: 'GET', path: '/api/scans/x/report.md' })
  })

  it('rejects a foreign Host on every route with 403, never echoing it', async () => {
    for (const { method, path } of routes) {
      const res = await rawRequest(path, method, { host: 'rebind.evil.example' })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(res.body).not.toContain('rebind.evil.example')
    }
  })

  it('rejects a foreign Origin on every route with 403', async () => {
    const { host } = new URL(url('/'))
    for (const { method, path } of routes) {
      const res = await rawRequest(path, method, { host, origin: 'https://evil.example' })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })

  it('rejects path spellings that would reach the API router', async () => {
    for (const path of ['//api/sites', '/API/sites', '/%61pi/sites', '/x/../api/sites']) {
      const res = await rawRequest(path, 'GET', { host: 'rebind.evil.example' })
      expect(res.status, path).toBe(403)
    }
  })

  it('rejects an HTTP/1.0 request that carries no Host', async () => {
    const { hostname, port } = new URL(url('/'))
    const head = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), hostname, () =>
        socket.end('GET /api/sites HTTP/1.0\r\n\r\n'),
      )
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => (data += chunk))
      socket.on('end', () => resolve(data))
      socket.on('error', reject)
    })
    expect(head).toMatch(/^HTTP\/1\.[01] 403/)
  })

  it('accepts every loopback spelling and a host listed in SAKUDA_ALLOWED_HOSTS', async () => {
    const { port } = new URL(url('/'))
    for (const name of ['localhost', '127.0.0.1', '[::1]', 'sakuda.lan']) {
      const res = await rawRequest('/api/sites', 'GET', {
        host: `${name}:${port}`,
        origin: `http://${name}:${port}`,
      })
      expect(res.status, name).toBe(200)
    }
  })

  it('keeps /mcp loopback-only even for a host in SAKUDA_ALLOWED_HOSTS', async () => {
    const res = await rawRequest('/mcp', 'POST', { host: 'sakuda.lan' })
    expect(res.status).toBe(403)
  })

  it('still renders pages on the server, whose data comes from /api/** (useFetch)', async () => {
    const created = await postJson('/api/sites', {
      name: 'Rendered on the server',
      frontBaseUrl: 'http://localhost:39996',
      nucleiPaths: '/',
    })
    expect(created.status).toBe(201)
    const page = await fetch('/')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Rendered on the server')
  })
})
