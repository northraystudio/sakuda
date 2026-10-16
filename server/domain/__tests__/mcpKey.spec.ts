import { describe, expect, it } from 'vitest'
import { generateMcpKey, hashMcpKey } from '../mcpKey'

describe('mcpKey', () => {
  it('generates distinct, prefixed 256-bit keys', () => {
    const a = generateMcpKey()
    expect(a).toMatch(/^sakuda_[A-Za-z0-9_-]{43}$/)
    expect(generateMcpKey()).not.toBe(a)
  })

  it('hashes to a stable sha256 hex that does not contain the key', () => {
    const key = generateMcpKey()
    expect(hashMcpKey(key)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashMcpKey(key)).toBe(hashMcpKey(key))
    expect(hashMcpKey(key)).not.toContain(key)
  })
})
