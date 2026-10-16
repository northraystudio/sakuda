import { describe, expect, it } from 'vitest'
import { diffFingerprints } from '../diff'

describe('diffFingerprints', () => {
  it('computes new/persisting/resolved counts over unique fingerprints', () => {
    expect(diffFingerprints(['a', 'b'], ['b', 'c', 'c'])).toEqual({
      new: 1,
      persisting: 1,
      resolved: 1,
      suppressed: 0,
    })
  })

  it('treats an empty previous set as all-new with nothing resolved', () => {
    expect(diffFingerprints([], ['a', 'b'])).toEqual({
      new: 2,
      persisting: 0,
      resolved: 0,
      suppressed: 0,
    })
  })

  it('treats an empty current set as everything resolved with nothing new', () => {
    expect(diffFingerprints(['a', 'b'], [])).toEqual({
      new: 0,
      persisting: 0,
      resolved: 2,
      suppressed: 0,
    })
  })

  it('returns all zero for two empty sets', () => {
    expect(diffFingerprints([], [])).toEqual({ new: 0, persisting: 0, resolved: 0, suppressed: 0 })
  })

  it('counts a would-be-new suppressed fingerprint as suppressed, not new', () => {
    expect(diffFingerprints(['a', 'b'], ['b', 'c', 'd'], new Set(['c', 'b']))).toEqual({
      new: 1,
      persisting: 1,
      resolved: 1,
      suppressed: 1,
    })
  })
})
