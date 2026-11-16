import { describe, expect, it, vi } from 'vitest'
import type { AuthCheckAnswer } from '../../domain/authCheck'
import { logger } from '../../lib/logger'
import type { AuthCheckSend } from '../authWatch'
import { findBlockedEntries } from '../entryCheck'
import type { SiteWithHeaders } from '../siteService'

const VITE_BLOCK = 'Blocked request. This host ("host.docker.internal") is not allowed.'
const blocked: AuthCheckAnswer = { status: 403, bodyHead: VITE_BLOCK }
const ok: AuthCheckAnswer = { status: 200, bodyHead: null }

// Only the fields the entry check reads; the rest of a site does not matter here.
function siteWith(apiBaseUrl: string | null): SiteWithHeaders {
  return {
    frontBaseUrl: 'http://localhost:3000',
    apiBaseUrl,
    headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
  } as SiteWithHeaders // partial fixture: see comment above
}

/** A sender answering per URL; an Error is thrown as a failed request. */
function answering(byUrl: Record<string, AuthCheckAnswer | Error>) {
  return vi.fn<AuthCheckSend>(async (url) => {
    const a = byUrl[url]
    if (a === undefined) throw new Error(`unexpected url ${url}`)
    if (a instanceof Error) throw a
    return a
  })
}

const run = (site: SiteWithHeaders, send: AuthCheckSend) =>
  findBlockedEntries({ site, send, logger, signal: new AbortController().signal })

describe('findBlockedEntries', () => {
  it('reports the entries that answered a known block page, with their status', async () => {
    const send = answering({
      'http://localhost:3000/': blocked,
      'http://localhost:8080/api/': ok,
    })
    expect(await run(siteWith('http://localhost:8080/api'), send)).toEqual([
      { entry: 'front', status: 403 },
    ])
    expect(send).toHaveBeenCalledWith(
      'http://localhost:3000/',
      [{ name: 'Authorization', value: 'Bearer secret-token' }],
      expect.any(AbortSignal),
    )
  })

  it('checks only the front when the site has no API base URL', async () => {
    const send = answering({ 'http://localhost:3000/': blocked })
    expect(await run(siteWith(null), send)).toEqual([{ entry: 'front', status: 403 }])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('checks a shared base URL once', async () => {
    const send = answering({ 'http://localhost:3000/': blocked })
    expect(await run(siteWith('http://localhost:3000'), send)).toEqual([
      { entry: 'front', status: 403 },
    ])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a 2xx', { status: 200, bodyHead: null }],
    ['a redirect', { status: 302, bodyHead: null }],
    ["the app's own 401", { status: 401, bodyHead: '{"error":"unauthorized"}' }],
    ["the app's own 403", { status: 403, bodyHead: '<h1>403 Forbidden</h1>' }],
  ])('records nothing for %s', async (_kind, answer) => {
    const send = answering({ 'http://localhost:3000/': answer })
    expect(await run(siteWith(null), send)).toEqual([])
  })

  it('skips an entry whose request fails and still checks the other one', async () => {
    const send = answering({
      'http://localhost:3000/': new Error('ECONNREFUSED'),
      'http://localhost:8080/': blocked,
    })
    expect(await run(siteWith('http://localhost:8080'), send)).toEqual([
      { entry: 'api', status: 403 },
    ])
  })
})
