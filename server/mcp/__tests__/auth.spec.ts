import { describe, expect, it } from 'vitest'
import { checkMcpRequest } from '../auth'

const KEY = 'k'.repeat(32)

describe('checkMcpRequest', () => {
  const loopback = { host: '127.0.0.1:3001', origin: null }

  it('without a configured key: allowed but never authenticated', () => {
    expect(checkMcpRequest({ ...loopback, authorization: null }, undefined)).toEqual({
      ok: true,
      authenticated: false,
    })
  })

  it('with a key: 401 when missing or wrong, authenticated when it matches', () => {
    expect(checkMcpRequest({ ...loopback, authorization: null }, KEY)).toMatchObject({
      ok: false,
      status: 401,
    })
    expect(checkMcpRequest({ ...loopback, authorization: 'Bearer nope' }, KEY)).toMatchObject({
      ok: false,
      status: 401,
    })
    expect(checkMcpRequest({ ...loopback, authorization: `Basic ${KEY}` }, KEY)).toMatchObject({
      ok: false,
      status: 401,
    })
    expect(checkMcpRequest({ ...loopback, authorization: `Bearer ${KEY}` }, KEY)).toEqual({
      ok: true,
      authenticated: true,
    })
  })

  it('checks Host/Origin before the key', () => {
    expect(
      checkMcpRequest({ host: 'evil.example', origin: null, authorization: `Bearer ${KEY}` }, KEY),
    ).toMatchObject({ ok: false, status: 403 })
  })
})
