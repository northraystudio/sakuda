import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../lib/logger'
import type { AuthCheckAnswer } from '../../domain/authCheck'
import { fetchAuthStatus, startAuthWatch, type AuthCheckSend } from '../authWatch'
import type { SiteWithHeaders } from '../siteService'
import type { ScanAuthLost } from '#shared/types/api'

// Real timers with a short interval: the watch is a small async loop, and
// fake timers would have to be interleaved with its awaits.

function siteWith(authCheckPath: string | null): SiteWithHeaders {
  // Only the fields the watch reads; the rest of a site is irrelevant here.
  return {
    frontBaseUrl: 'http://localhost:3000',
    apiBaseUrl: null,
    authCheckPath,
    headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
  } as SiteWithHeaders // partial fixture: see comment above
}

/** A sender that answers the given statuses (or full answers) in order,
 * then repeats the last. */
function answering(...results: (number | AuthCheckAnswer | Error)[]): AuthCheckSend {
  let i = 0
  return vi.fn(async () => {
    const r = results[Math.min(i++, results.length - 1)]!
    if (r instanceof Error) throw r
    return typeof r === 'number' ? { status: r, bodyHead: null } : r
  })
}

const now = () => new Date('2026-02-01T00:00:00.000Z')

function watch(path: string | null, send: AuthCheckSend) {
  const lost: ScanAuthLost[] = []
  const w = startAuthWatch({
    site: siteWith(path),
    config: { send, intervalMs: 5 },
    logger,
    now,
    onLost: (l) => lost.push(l),
  })
  return { w, lost }
}

describe('startAuthWatch', () => {
  it('does nothing when the site has no check path', () => {
    const send = answering(401)
    expect(watch(null, send).w).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('reports the first 401 once, after the login had been working', async () => {
    const send = answering(200, 200, 401, 401)
    const { w, lost } = watch('/me', send)
    await vi.waitFor(() => expect(lost).toHaveLength(1), { timeout: 2000, interval: 5 })
    await w?.stop()
    expect(lost[0]).toEqual({ detectedAt: '2026-02-01T00:00:00.000Z', path: '/me', status: 401 })
    expect(send).toHaveBeenCalledTimes(3) // stops checking once the login is lost
  })

  it('adds the block-page hint to the lost login it reports (#79)', async () => {
    const block = { status: 403, bodyHead: 'Blocked request. This host ("x") is not allowed.' }
    const { w, lost } = watch('/me', answering(block))
    await vi.waitFor(() => expect(lost).toHaveLength(1), { timeout: 2000, interval: 5 })
    await w?.stop()
    expect(lost[0]).toEqual({
      detectedAt: '2026-02-01T00:00:00.000Z',
      path: '/me',
      status: 403,
      hint: 'blocked-before-app',
    })
  })

  it('reports a login that is already rejected at the start', async () => {
    const { w, lost } = watch('/me', answering(403))
    await vi.waitFor(() => expect(lost).toHaveLength(1), { timeout: 2000, interval: 5 })
    await w?.stop()
    expect(lost[0]?.status).toBe(403)
  })

  it('treats a check with no answer as unknown and keeps checking', async () => {
    const send = answering(new Error('ECONNREFUSED'), 200, 200)
    const { w, lost } = watch('/me', send)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3), { timeout: 2000, interval: 5 })
    await w?.stop()
    expect(lost).toEqual([])
  })

  it('sends the site headers to the resolved URL', async () => {
    const send = answering(200)
    const { w } = watch('/me', send)
    await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 2000, interval: 5 })
    await w?.stop()
    expect(send).toHaveBeenCalledWith(
      'http://localhost:3000/me',
      [{ name: 'Authorization', value: 'Bearer secret-token' }],
      expect.any(AbortSignal),
    )
  })

  it('stops checking after stop()', async () => {
    const send = answering(200)
    const { w, lost } = watch('/me', send)
    await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 2000, interval: 5 })
    await w?.stop()
    const calls = vi.mocked(send).mock.calls.length
    await new Promise((r) => setTimeout(r, 30))
    expect(vi.mocked(send).mock.calls.length).toBe(calls)
    expect(lost).toEqual([])
  })
})

describe('fetchAuthStatus (#79)', () => {
  afterEach(() => vi.unstubAllGlobals())

  const respond = (res: Response) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    )
  const send = (url = 'http://localhost:3000/me') =>
    fetchAuthStatus('host.docker.internal')(url, [], AbortSignal.timeout(1000))

  it('reads the start of a 401/403 body, at most 1KB of it', async () => {
    respond(new Response('Blocked request. ' + 'x'.repeat(5000), { status: 403 }))
    const answer = await send()
    expect(answer.status).toBe(403)
    expect(answer.bodyHead?.startsWith('Blocked request.')).toBe(true)
    expect(answer.bodyHead).toHaveLength(1024)
  })

  it('keeps at most 1KB of a body that arrives as one large chunk', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('Blocked request. ' + 'y'.repeat(64 * 1024)))
        c.close()
      },
    })
    respond(new Response(body, { status: 403 }))
    const answer = await send()
    expect(answer.bodyHead).toHaveLength(1024)
    expect(answer.bodyHead?.startsWith('Blocked request.')).toBe(true)
  })

  it('does not read the body of any other status', async () => {
    respond(new Response('welcome', { status: 200 }))
    expect(await send()).toEqual({ status: 200, bodyHead: null })
  })

  it('keeps the status when the rejection body fails to read', async () => {
    const body = new ReadableStream({
      pull(c) {
        c.error(new Error('socket hang up'))
      },
    })
    respond(new Response(body, { status: 401 }))
    expect(await send()).toEqual({ status: 401, bodyHead: null, bodyReadError: 'socket hang up' })
  })

  it('sends to the localhost alias without following redirects', async () => {
    respond(new Response(null, { status: 204 }))
    await send()
    expect(fetch).toHaveBeenCalledWith(
      'http://host.docker.internal:3000/me',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    )
  })
})
