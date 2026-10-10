import { describe, expect, it } from 'vitest'
import { effectiveNucleiLimits, effectiveNucleiMaxMinutes } from '../nucleiLimits'

const env = { maxMinutes: 60, concurrency: 25 }

describe('effectiveNucleiLimits (#10)', () => {
  it('uses the site values when set', () => {
    expect(effectiveNucleiLimits({ nucleiMaxMinutes: 240, nucleiConcurrency: 8 }, env)).toEqual({
      maxMinutes: { minutes: 240, source: 'site' },
      concurrency: 8,
    })
  })

  it('falls back to the env values when the site leaves them null', () => {
    expect(effectiveNucleiLimits({ nucleiMaxMinutes: null, nucleiConcurrency: null }, env)).toEqual(
      { maxMinutes: { minutes: 60, source: 'env' }, concurrency: 25 },
    )
  })

  it('resolves each knob on its own', () => {
    expect(effectiveNucleiLimits({ nucleiMaxMinutes: null, nucleiConcurrency: 8 }, env)).toEqual({
      maxMinutes: { minutes: 60, source: 'env' },
      concurrency: 8,
    })
  })

  it('treats a snapshot taken before #10 (fields absent) as no override', () => {
    expect(effectiveNucleiLimits({}, env)).toEqual({
      maxMinutes: { minutes: 60, source: 'env' },
      concurrency: 25,
    })
    expect(effectiveNucleiMaxMinutes({}, 90)).toEqual({ minutes: 90, source: 'env' })
  })
})
