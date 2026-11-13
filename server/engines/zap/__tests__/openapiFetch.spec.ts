import { describe, expect, it } from 'vitest'
import { EngineError } from '../../types'
import {
  fetchOpenapiDoc,
  OPENAPI_FETCH_MAX_BYTES,
  OPENAPI_FETCH_MAX_REDIRECTS,
} from '../openapiFetch'

type Route = (url: string, init: RequestInit) => Response

/** A fetch that answers from a URL → handler map and records every request. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const impl = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    if (!route) return Promise.reject(new TypeError(`unexpected request to ${url}`))
    return Promise.resolve(route(url, init ?? {}))
  }
  // as: the fake implements only the call signature fetchOpenapiDoc uses
  return { impl: impl as typeof fetch, calls }
}

const redirect =
  (to: string, status = 302): Route =>
  () =>
    new Response(null, { status, headers: { location: to } })
const doc =
  (body = '{"openapi":"3.0.0"}'): Route =>
  () =>
    new Response(body, { status: 200 })

const base = {
  allowedOrigins: ['https://app.example.com', 'https://api.example.com'],
  headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
  localhostAlias: undefined,
  signal: new AbortController().signal,
}

describe('fetchOpenapiDoc', () => {
  it('returns the document and sends the site headers', async () => {
    const f = fakeFetch({ 'https://api.example.com/openapi.json': doc() })
    const text = await fetchOpenapiDoc({
      ...base,
      url: 'https://api.example.com/openapi.json',
      fetchImpl: f.impl,
    })
    expect(text).toBe('{"openapi":"3.0.0"}')
    expect(f.calls[0]?.headers.get('authorization')).toBe('Bearer secret-token')
  })

  it('follows a redirect to the same origin and to another allowed origin', async () => {
    const f = fakeFetch({
      'https://docs.example.com/spec': redirect('/spec/v2'),
      'https://docs.example.com/spec/v2': redirect('https://api.example.com/openapi.json', 301),
      'https://api.example.com/openapi.json': doc(),
    })
    const text = await fetchOpenapiDoc({
      ...base,
      url: 'https://docs.example.com/spec',
      fetchImpl: f.impl,
    })
    expect(text).toBe('{"openapi":"3.0.0"}')
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://docs.example.com/spec',
      'https://docs.example.com/spec/v2',
      'https://api.example.com/openapi.json',
    ])
  })

  it('refuses a redirect off the allowed origins without sending anything there (#57)', async () => {
    const f = fakeFetch({
      'https://api.example.com/openapi.json': redirect('https://evil.example.net/openapi.json'),
    })
    const p = fetchOpenapiDoc({
      ...base,
      url: 'https://api.example.com/openapi.json',
      fetchImpl: f.impl,
    })
    await expect(p).rejects.toThrow(EngineError)
    await expect(p).rejects.toThrow(/redirected to https:\/\/evil\.example\.net/)
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.example.com/openapi.json'])
  })

  it('refuses a redirect from a non-local URL to a local (internal) host', async () => {
    const f = fakeFetch({
      'https://api.example.com/openapi.json': redirect('http://10.0.0.5/admin'),
    })
    await expect(
      fetchOpenapiDoc({ ...base, url: 'https://api.example.com/openapi.json', fetchImpl: f.impl }),
    ).rejects.toThrow(/redirected to http:\/\/10\.0\.0\.5/)
    expect(f.calls).toHaveLength(1)
  })

  it('lets a local URL move to another local host', async () => {
    const f = fakeFetch({
      'http://localhost:3000/openapi.json': redirect('http://127.0.0.1:3001/openapi.json'),
      'http://127.0.0.1:3001/openapi.json': doc(),
    })
    await expect(
      fetchOpenapiDoc({
        ...base,
        allowedOrigins: ['http://localhost:3000'],
        url: 'http://localhost:3000/openapi.json',
        fetchImpl: f.impl,
      }),
    ).resolves.toBe('{"openapi":"3.0.0"}')
  })

  it('requests through the loopback alias and maps an aliased Location back', async () => {
    const f = fakeFetch({
      'http://host.docker.internal:3000/openapi.json': redirect(
        'http://host.docker.internal:3000/v2/openapi.json',
      ),
      'http://host.docker.internal:3000/v2/openapi.json': doc(),
    })
    await expect(
      fetchOpenapiDoc({
        ...base,
        allowedOrigins: ['https://app.example.com'],
        url: 'http://localhost:3000/openapi.json',
        localhostAlias: 'host.docker.internal',
        fetchImpl: f.impl,
      }),
    ).resolves.toBe('{"openapi":"3.0.0"}')
  })

  it(`gives up after ${OPENAPI_FETCH_MAX_REDIRECTS} redirects`, async () => {
    const f = fakeFetch({ 'https://api.example.com/loop': redirect('/loop') })
    await expect(
      fetchOpenapiDoc({ ...base, url: 'https://api.example.com/loop', fetchImpl: f.impl }),
    ).rejects.toThrow(/redirected more than/)
    expect(f.calls).toHaveLength(OPENAPI_FETCH_MAX_REDIRECTS + 1)
  })

  it('reports a non-2xx answer without the headers or the URL path', async () => {
    const f = fakeFetch({
      'https://api.example.com/openapi.json?key=abc': () => new Response('no', { status: 401 }),
    })
    const err = await fetchOpenapiDoc({
      ...base,
      url: 'https://api.example.com/openapi.json?key=abc',
      fetchImpl: f.impl,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineError)
    expect(String(err)).toMatch(/HTTP 401/)
    expect(String(err)).not.toMatch(/secret-token|key=abc/)
  })

  it('refuses a redirect without a Location header', async () => {
    const f = fakeFetch({ 'https://api.example.com/x': () => new Response(null, { status: 302 }) })
    await expect(
      fetchOpenapiDoc({ ...base, url: 'https://api.example.com/x', fetchImpl: f.impl }),
    ).rejects.toThrow(/without a Location header/)
  })

  it('refuses a document over the size cap instead of truncating it', async () => {
    const big = 'x'.repeat(OPENAPI_FETCH_MAX_BYTES + 1)
    const f = fakeFetch({ 'https://api.example.com/big': doc(big) })
    await expect(
      fetchOpenapiDoc({ ...base, url: 'https://api.example.com/big', fetchImpl: f.impl }),
    ).rejects.toThrow(/larger than/)
  })

  it('reports a connection failure as an EngineError with the reason', async () => {
    const f = fakeFetch({})
    await expect(
      fetchOpenapiDoc({ ...base, url: 'https://api.example.com/openapi.json', fetchImpl: f.impl }),
    ).rejects.toThrow(
      /could not fetch the OpenAPI document from https:\/\/api\.example\.com \(TypeError\)/,
    )
  })
})
