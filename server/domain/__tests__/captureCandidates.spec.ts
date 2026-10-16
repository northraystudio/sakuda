import { describe, expect, it } from 'vitest'
import { buildCaptureCandidates } from '../captureCandidates'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'

describe('buildCaptureCandidates', () => {
  it('proposes storage rows, a joined Cookie header and a Bearer header from a JWT', () => {
    const r = buildCaptureCandidates({
      localStorage: [['token', JWT]],
      sessionStorage: [['bid', '6']],
      cookies: [
        { name: 'sid', value: 's1', expires: 1_800_000_000 },
        { name: 'lang', value: 'en', expires: -1 },
        { name: 'csrf', value: 'c1', expires: 1_700_000_000 },
      ],
    })
    expect(r.browserStorage).toEqual([
      { kind: 'localStorage', name: 'token', value: JWT },
      { kind: 'sessionStorage', name: 'bid', value: '6' },
      { kind: 'cookie', name: 'sid', value: 's1', expiresAt: '2027-01-15T08:00:00.000Z' },
      { kind: 'cookie', name: 'lang', value: 'en' },
      { kind: 'cookie', name: 'csrf', value: 'c1', expiresAt: '2023-11-14T22:13:20.000Z' },
    ])
    expect(r.headers).toEqual([
      // earliest cookie expiry; the session cookie has none
      { name: 'Cookie', value: 'sid=s1; lang=en; csrf=c1', expiresAt: '2023-11-14T22:13:20.000Z' },
      { name: 'Authorization', value: `Bearer ${JWT}` },
    ])
    expect(r.skipped).toEqual([])
  })

  it('keeps an existing "Bearer " prefix and proposes no header when there is nothing to send', () => {
    expect(
      buildCaptureCandidates({
        localStorage: [['auth', `Bearer ${JWT}`]],
        sessionStorage: [],
        cookies: [],
      }).headers,
    ).toEqual([{ name: 'Authorization', value: `Bearer ${JWT}` }])
    expect(
      buildCaptureCandidates({ localStorage: [['theme', 'dark']], sessionStorage: [], cookies: [] })
        .headers,
    ).toEqual([])
  })

  it('reports values the schema rejects instead of dropping them silently', () => {
    const r = buildCaptureCandidates({
      localStorage: [
        ['multi', 'line\nvalue'],
        ['empty', ''],
      ],
      sessionStorage: [],
      cookies: [{ name: 'bad', value: 'a;b' }],
    })
    expect(r.browserStorage).toEqual([])
    expect(r.skipped.map((s) => s.item)).toEqual([
      'localStorage:multi',
      'localStorage:empty',
      'cookie:bad',
    ])
    expect(r.headers).toEqual([])
  })

  it('caps the rows at the storage limit and reports the rest', () => {
    const many = Array.from({ length: 22 }, (_, i): [string, string] => [`k${i}`, 'v'])
    const r = buildCaptureCandidates({ localStorage: many, sessionStorage: [], cookies: [] })
    expect(r.browserStorage).toHaveLength(20)
    expect(r.skipped).toEqual([
      { item: 'localStorage:k20', reason: 'over the 20-item limit' },
      { item: 'localStorage:k21', reason: 'over the 20-item limit' },
    ])
  })
})
