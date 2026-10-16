import { describe, expect, it } from 'vitest'
import { checkMcpRequest } from '../auth'
import type { McpKeyLookup } from '../../services/mcpKeyService'

const KEY = 'sakuda_' + 'k'.repeat(43)

function keys(...valid: string[]): McpKeyLookup {
  return { hasActiveKeys: () => valid.length > 0, isValidKey: (k) => valid.includes(k) }
}

describe('checkMcpRequest', () => {
  const loopback = { host: '127.0.0.1:3001', origin: null }

  it('with no issued key: allowed but never authenticated', () => {
    expect(checkMcpRequest({ ...loopback, authorization: null }, keys())).toEqual({
      ok: true,
      authenticated: false,
    })
    // A stray header must not turn into authentication when no key exists.
    expect(checkMcpRequest({ ...loopback, authorization: `Bearer ${KEY}` }, keys())).toEqual({
      ok: true,
      authenticated: false,
    })
  })

  it('with a key issued: 401 when missing or wrong, authenticated when it matches', () => {
    for (const authorization of [null, 'Bearer nope', `Basic ${KEY}`, 'Bearer    '])
      expect(checkMcpRequest({ ...loopback, authorization }, keys(KEY))).toMatchObject({
        ok: false,
        status: 401,
      })
    expect(checkMcpRequest({ ...loopback, authorization: `Bearer ${KEY}` }, keys(KEY))).toEqual({
      ok: true,
      authenticated: true,
    })
    expect(
      checkMcpRequest({ ...loopback, authorization: `bearer  ${KEY} ` }, keys('other', KEY)),
    ).toEqual({ ok: true, authenticated: true })
  })

  it('checks Host/Origin before the key', () => {
    expect(
      checkMcpRequest(
        { host: 'evil.example', origin: null, authorization: `Bearer ${KEY}` },
        keys(KEY),
      ),
    ).toMatchObject({ ok: false, status: 403 })
  })
})
