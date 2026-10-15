import { describe, expect, it } from 'vitest'
import type { IntrusionHud, Lane } from '~/utils/intrusion/hud'
import {
  bannerVisible,
  createSim,
  isSettled,
  LOG_LINES,
  RINGS,
  SEGMENT_COUNT,
  settleSim,
  stepSim,
  syncSim,
  type SimState,
} from '~/utils/intrusion/sim'

const CORE = RINGS[RINGS.length - 1]!.segments

function lanes(...states: Lane['state'][]): Lane[] {
  const engines = ['zap-fe', 'dalfox', 'nuclei'] as const
  return states.map((state, i) => ({ engine: engines[i]!, state, findings: 0 }))
}

function hud(overrides: Partial<IntrusionHud> = {}): IntrusionHud {
  return {
    lanes: lanes('running'),
    active: 0,
    phase: 1,
    findings: 0,
    progress: 0,
    outcome: null,
    ...overrides,
  }
}

function run(s: SimState, ms: number): void {
  for (let t = 0; t < ms; t += 33) stepSim(s, 33)
}

describe('intrusion simulation', () => {
  it('starts with every defense standing and raises the phase banner', () => {
    const s = createSim()
    syncSim(s, hud(), null)
    expect(s.brokenCount).toBe(0)
    expect(bannerVisible(s)).toBe(true)
    expect(s.logs.at(-1)?.text).toBe('> launching zap-fe ...')
  })

  it('progress breaks segments over time — never the core while the scan runs', () => {
    const s = createSim()
    syncSim(s, hud({ progress: 0.5 }), null)
    run(s, 10_000)
    expect(s.brokenCount).toBe(Math.floor(SEGMENT_COUNT / 2))

    syncSim(s, hud({ progress: 1 }), null)
    run(s, 10_000)
    expect(s.brokenCount).toBe(SEGMENT_COUNT - CORE)
  })

  it('never repairs a segment when progress goes backwards', () => {
    const s = createSim()
    syncSim(s, hud({ progress: 0.5 }), null)
    run(s, 10_000)
    const broken = s.brokenCount
    syncSim(s, hud({ progress: 0.1 }), null)
    run(s, 1_000)
    expect(s.brokenCount).toBe(broken)
  })

  it('new findings flash the target; findings present on first sync do not', () => {
    const s = createSim()
    syncSim(s, hud({ findings: 4 }), null)
    expect(s.flashMs).toBe(0)
    syncSim(s, hud({ findings: 5 }), null)
    expect(s.flashMs).toBeGreaterThan(0)
    expect(s.pops.some((p) => p.active)).toBe(true)
    expect(s.logs.at(-1)?.text).toBe('> zap-fe :: vuln matched (total 5)')
  })

  it('consecutive hits share one terminal line', () => {
    const s = createSim()
    syncSim(s, hud(), null)
    syncSim(s, hud({ findings: 1 }), null)
    syncSim(s, hud({ findings: 2 }), null)
    expect(s.logs.filter((l) => l.kind === 'hit')).toHaveLength(1)
  })

  it('logs stage changes once and keeps only the last few lines', () => {
    const s = createSim()
    syncSim(s, hud(), 'spider')
    syncSim(s, hud(), 'spider')
    syncSim(s, hud(), 'ajaxSpider')
    syncSim(s, hud(), 'activeScan')
    expect(s.logs).toHaveLength(LOG_LINES)
    expect(s.logs.map((l) => l.text)).toEqual([
      '> zap-fe :: spider',
      '> zap-fe :: ajaxSpider',
      '> zap-fe :: activeScan',
    ])
  })

  it('a phase change reports the finished engine and launches the next', () => {
    const s = createSim()
    syncSim(s, hud({ lanes: lanes('running', 'queued') }), null)
    const next = lanes('done', 'running')
    next[0]!.findings = 2
    syncSim(s, hud({ lanes: next, active: 1, phase: 2 }), null)
    expect(s.logs.slice(-2).map((l) => l.text)).toEqual([
      '> zap-fe :: done (2 vuln)',
      '> launching dalfox ...',
    ])
  })

  it('complete: every segment, core included, falls and the loop may stop', () => {
    const s = createSim()
    syncSim(s, hud({ progress: 0.9 }), null)
    syncSim(s, hud({ progress: 1, outcome: 'complete' }), null)
    expect(isSettled(s)).toBe(false)
    run(s, 10_000)
    expect(s.brokenCount).toBe(SEGMENT_COUNT)
    expect(isSettled(s)).toBe(true)
  })

  it('lost: packets stop, the core holds, and the loop may stop', () => {
    const s = createSim()
    syncSim(s, hud({ progress: 0.3 }), null)
    run(s, 2_000)
    syncSim(s, hud({ progress: 0.3, outcome: 'lost' }), null)
    run(s, 10_000)
    expect(s.packets.some((p) => p.active)).toBe(false)
    expect(s.brokenCount).toBeLessThan(SEGMENT_COUNT - CORE)
    expect(s.logs.at(-1)?.text).toBe('> zap-fe :: connection lost')
    expect(isSettled(s)).toBe(true)
  })

  it('settleSim applies owed breaks at once (reduced motion)', () => {
    const s = createSim()
    syncSim(s, hud({ progress: 0.5 }), null)
    settleSim(s)
    expect(s.brokenCount).toBe(Math.floor(SEGMENT_COUNT / 2))
    expect(s.sparks.some((sp) => sp.active)).toBe(false)
  })
})
