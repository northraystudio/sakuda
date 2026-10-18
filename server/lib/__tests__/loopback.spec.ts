import { describe, expect, it } from 'vitest'
import { isApiPath, isLoopbackRequest } from '../loopback'

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

  it('accepts an allowed host in Host and Origin, and nothing else (#22)', () => {
    const allowed = ['sakuda.lan']
    expect(isLoopbackRequest('sakuda.lan:3000', null, allowed)).toBe(true)
    expect(isLoopbackRequest('SAKUDA.lan', 'http://sakuda.lan:3000', allowed)).toBe(true)
    expect(isLoopbackRequest('localhost:3000', 'http://sakuda.lan', allowed)).toBe(true)
    expect(isLoopbackRequest('evil.example', null, allowed)).toBe(false)
    expect(isLoopbackRequest('sakuda.lan', 'https://evil.example', allowed)).toBe(false)
    expect(isLoopbackRequest('sakuda.lan.evil.example', null, allowed)).toBe(false)
    expect(isLoopbackRequest('sakuda.lan', 'null', allowed)).toBe(false)
    expect(isLoopbackRequest(null, null, allowed)).toBe(false)
    // Without the list (MCP), the same host is refused.
    expect(isLoopbackRequest('sakuda.lan', null)).toBe(false)
  })
})

describe('isApiPath', () => {
  it.each([
    '/api',
    '/api/sites',
    '/api/sites?x=1',
    '//api/sites',
    '/API/sites',
    '/%61pi/sites',
    '/%2fapi/sites',
    '/x/../api/sites',
    '/./api/sites',
    '/%2e%2e/api/sites',
    '/api%2fsites',
    '/%2f%2fapi/sites',
    '/x/%2e%2e/api/sites',
  ])('guards %s', (path) => {
    expect(isApiPath(path)).toBe(true)
  })

  it('guards a path it cannot decode (deny by default)', () => {
    expect(isApiPath('/%E0%A4%A')).toBe(true)
  })

  it.each([
    '/',
    '/sites/abc',
    '/mcp-keys',
    '/_nuxt/entry.js',
    '/mcp',
    '/apis',
    '/x/api',
    '/%3f/api/sites',
  ])('leaves %s to its own handling', (path) => {
    expect(isApiPath(path)).toBe(false)
  })
})
