import { describe, expect, it } from 'vitest'
import { checkMcpRequest, isLoopbackRequest } from '../auth'

const KEY = 'k'.repeat(32)

describe('isLoopbackRequest', () => {
  it.each(['localhost:3001', '127.0.0.1:3001', '[::1]:3001', 'LOCALHOST'])('accepts %s', (h) => {
    expect(isLoopbackRequest(h, null)).toBe(true)
  })

  it('rejects a rebinding host name and a missing Host', () => {
    expect(isLoopbackRequest('evil.example:3001', null)).toBe(false)
    expect(isLoopbackRequest(null, null)).toBe(false)
  })

  it('rejects a foreign Origin even with a loopback Host', () => {
    expect(isLoopbackRequest('127.0.0.1:3001', 'https://evil.example')).toBe(false)
    expect(isLoopbackRequest('127.0.0.1:3001', 'http://localhost:3000')).toBe(true)
    expect(isLoopbackRequest('127.0.0.1:3001', 'null')).toBe(false)
  })
})

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
