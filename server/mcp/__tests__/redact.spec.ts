import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_MAX_CHARS,
  collectSecrets,
  redactDeep,
  redactText,
  wrapUntrusted,
} from '../redact'

describe('collectSecrets', () => {
  it('labels header, bearer credential, cookie and storage values; longest first', () => {
    const secrets = collectSecrets(
      [
        { name: 'Authorization', value: 'Bearer tok-123456' },
        { name: 'Cookie', value: 'sid=session-abcdef; lang=ja' },
      ],
      [{ kind: 'localStorage', name: 'token', value: 'local-token-value' }],
    )
    expect(secrets.map((s) => s.label)).toEqual([
      'header:Cookie',
      'header:Authorization',
      'storage:localStorage:token',
      'cookie:sid',
      'header:Authorization',
    ])
    expect(secrets.map((s) => s.value)).toContain('tok-123456')
    expect(secrets.map((s) => s.value)).toContain('session-abcdef')
  })

  it('skips values too short to redact without shredding ordinary text', () => {
    expect(collectSecrets([{ name: 'X-Flag', value: 'on' }], [])).toEqual([])
  })
})

describe('redactText / redactDeep', () => {
  const secrets = collectSecrets([{ name: 'Authorization', value: 'Bearer tok-123456' }], [])

  it('replaces the whole header before the bare credential', () => {
    expect(redactText('h: Bearer tok-123456 / t=tok-123456', secrets)).toBe(
      'h: [SECRET:header:Authorization] / t=[SECRET:header:Authorization]',
    )
  })

  it('walks nested objects and arrays, leaving non-strings alone', () => {
    const out = redactDeep({ a: ['x tok-123456'], b: { c: 'tok-123456' }, n: 1, z: null }, secrets)
    expect(out).toEqual({
      a: ['x [SECRET:header:Authorization]'],
      b: { c: '[SECRET:header:Authorization]' },
      n: 1,
      z: null,
    })
  })

  it('returns the value untouched when there is nothing to hide', () => {
    const value = { a: 'tok-123456' }
    expect(redactDeep(value, [])).toBe(value)
  })
})

describe('wrapUntrusted', () => {
  it('marks evidence as untrusted target output', () => {
    expect(wrapUntrusted('body')).toEqual({
      untrusted: true,
      source: 'target-response',
      text: 'body',
      truncated: false,
    })
  })

  it('truncates past the limit and says so', () => {
    const w = wrapUntrusted('a'.repeat(EVIDENCE_MAX_CHARS + 1))
    expect(w.text).toHaveLength(EVIDENCE_MAX_CHARS)
    expect(w.truncated).toBe(true)
  })
})
