import { describe, expect, it } from 'vitest'
import { isLoopbackRequest } from '../loopback'

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
