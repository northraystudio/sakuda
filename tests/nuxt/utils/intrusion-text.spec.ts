import { describe, expect, it } from 'vitest'
import { fitText } from '~/utils/intrusion/text'

// One unit per code point keeps the arithmetic obvious.
const measure = (s: string) => Array.from(s).length

describe('fitText', () => {
  it('leaves a name that fits untouched', () => {
    expect(fitText('SHOP', 4, measure)).toBe('SHOP')
  })

  it('cuts a long name with an ellipsis inside the width', () => {
    expect(fitText('JUICE SHOP STAGING', 8, measure)).toBe('JUICE S…')
  })

  it('never splits a surrogate pair', () => {
    expect(fitText('🍊🍊🍊🍊', 3, measure)).toBe('🍊🍊…')
  })
})
