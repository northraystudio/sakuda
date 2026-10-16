import { describe, expect, it } from 'vitest'
import { jwtExpiry, resolveSecretExpiries } from '../secretExpiry'
import { findExpiryProblems, formatExpiryWarning, secretKey } from '#shared/utils/secretExpiry'

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}.sig`
}

const EXP = 1_800_000_000 // 2027-01-15T08:00:00.000Z
const EXP_ISO = new Date(EXP * 1000).toISOString()

describe('secretKey', () => {
  it('prefixes headers and storage items differently', () => {
    expect(secretKey({ name: 'Authorization' })).toBe('header:Authorization')
    expect(secretKey({ kind: 'cookie', name: 'sid' })).toBe('cookie:sid')
  })
})

describe('jwtExpiry', () => {
  it('reads exp from a bare token, a Bearer value and a cookie string', () => {
    const t = jwt({ exp: EXP })
    expect(jwtExpiry(t)).toBe(EXP_ISO)
    expect(jwtExpiry(`Bearer ${t}`)).toBe(EXP_ISO)
    expect(jwtExpiry(`lang=en; token=${t}; x=1`)).toBe(EXP_ISO)
  })

  it('takes the earliest exp when several JWTs are present', () => {
    expect(jwtExpiry(`a=${jwt({ exp: EXP + 60 })}; b=${jwt({ exp: EXP })}`)).toBe(EXP_ISO)
  })

  it('returns null for no JWT, no exp, a non-numeric exp, or garbage', () => {
    expect(jwtExpiry('opaque-session-id')).toBeNull()
    expect(jwtExpiry(jwt({ sub: 'x' }))).toBeNull() // Juice Shop tokens carry no exp
    expect(jwtExpiry(jwt({ exp: 'soon' }))).toBeNull()
    expect(jwtExpiry('eyJhbGc.eyJnot-json.x')).toBeNull()
  })
})

describe('resolveSecretExpiries', () => {
  const previous = { 'cookie:sid': '2026-12-01T00:00:00.000Z' }

  it('prefers an explicit expiry, keeps the previous one for kept values, else uses JWT exp', () => {
    expect(
      resolveSecretExpiries(
        [
          { key: 'cookie:sid', value: 'opaque', kept: true },
          {
            key: 'cookie:new',
            value: 'opaque',
            expiresAt: '2026-11-01T00:00:00.000Z',
            kept: false,
          },
          { key: 'header:Authorization', value: `Bearer ${jwt({ exp: EXP })}`, kept: false },
          { key: 'header:X-Key', value: 'opaque', kept: false },
        ],
        previous,
      ),
    ).toEqual({
      'cookie:sid': '2026-12-01T00:00:00.000Z',
      'cookie:new': '2026-11-01T00:00:00.000Z',
      'header:Authorization': EXP_ISO,
    })
  })

  it('drops the previous expiry when the value was replaced or the item removed', () => {
    expect(
      resolveSecretExpiries([{ key: 'cookie:sid', value: 'fresh', kept: false }], previous),
    ).toEqual({})
    expect(resolveSecretExpiries([], previous)).toEqual({})
  })
})

describe('findExpiryProblems', () => {
  const now = new Date('2026-10-16T12:00:00.000Z')

  it('reports expired and soon-expiring secrets, earliest first, and ignores the rest', () => {
    expect(
      findExpiryProblems(
        {
          'header:Authorization': '2026-10-16T12:30:00.000Z', // 30 min left
          'cookie:sid': '2026-10-16T11:00:00.000Z', // expired
          'localStorage:token': '2026-10-16T14:00:00.000Z', // 2 h left
          'cookie:bad': 'not-a-date',
        },
        now,
      ),
    ).toEqual([
      { key: 'cookie:sid', expiresAt: '2026-10-16T11:00:00.000Z', state: 'expired' },
      { key: 'header:Authorization', expiresAt: '2026-10-16T12:30:00.000Z', state: 'soon' },
    ])
  })

  it('treats exactly now as expired and exactly the threshold as soon', () => {
    expect(findExpiryProblems({ a: now.toISOString() }, now)[0]?.state).toBe('expired')
    expect(findExpiryProblems({ a: '2026-10-16T13:00:00.000Z' }, now)[0]?.state).toBe('soon')
  })

  it('formats a runbook-friendly warning', () => {
    expect(
      formatExpiryWarning({
        key: 'cookie:sid',
        expiresAt: '2026-10-16T11:00:00.000Z',
        state: 'expired',
      }),
    ).toMatch(/^cookie:sid expired at 2026-10-16T11:00:00.000Z — .*Edit site/)
  })
})
