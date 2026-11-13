import { describe, expect, it, vi } from 'vitest'
import { logger } from '../../lib/logger'
import { startAuthWatch, type AuthCheckSend } from '../authWatch'
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

/** A sender that answers the given statuses in order, then repeats the last. */
function answering(...results: (number | Error)[]): AuthCheckSend {
  let i = 0
  return vi.fn(async () => {
    const r = results[Math.min(i++, results.length - 1)]!
    if (r instanceof Error) throw r
    return r
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
