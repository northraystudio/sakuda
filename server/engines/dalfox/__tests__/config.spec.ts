import { describe, expect, it } from 'vitest'
import { dalfoxScanTimeoutSec } from '../config'

describe('dalfoxScanTimeoutSec', () => {
  it('lets one target use 60% of the budget when the per-wave share is smaller (#67)', () => {
    // Defaults: 600 s budget, 50 targets, 10 concurrent → per-wave share 120 s.
    expect(dalfoxScanTimeoutSec(600, 50, 10)).toBe(360)
  })

  it('never drops below the per-wave share', () => {
    // One wave: the whole budget, as before.
    expect(dalfoxScanTimeoutSec(600, 5, 10)).toBe(600)
    expect(dalfoxScanTimeoutSec(600, 10, 10)).toBe(600)
  })

  it('keeps the 15 s floor for a tiny budget', () => {
    expect(dalfoxScanTimeoutSec(20, 50, 10)).toBe(15)
  })

  it('treats a zero target count as one wave', () => {
    expect(dalfoxScanTimeoutSec(600, 0, 10)).toBe(600)
  })
})
