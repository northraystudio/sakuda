import { describe, expect, it } from 'vitest'
import { deriveIntrusionHud, finaleFor, RUNNING_PROGRESS_CAP } from '~/utils/intrusion/hud'
import { engineRunFixture } from '../helpers/fixtures'
import type { EngineProgressView } from '#shared/types/api'

const ZERO = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
const NOW = new Date('2026-01-01T00:15:00.000Z')

describe('deriveIntrusionHud', () => {
  it('queued: every engine waits on the rail in run order, nothing attacks', () => {
    const hud = deriveIntrusionHud({
      status: 'queued',
      engines: ['nuclei', 'zap-fe'],
      engineRuns: [],
      progress: null,
      now: NOW,
    })
    expect(hud.lanes).toEqual([
      { engine: 'zap-fe', state: 'queued', findings: 0 },
      { engine: 'nuclei', state: 'queued', findings: 0 },
    ])
    expect(hud).toMatchObject({ active: -1, phase: 0, findings: 0, progress: 0, outcome: null })
  })

  it('running: the running engine attacks; progress counts finished engines plus its share', () => {
    const hud = deriveIntrusionHud({
      status: 'running',
      engines: ['nuclei', 'zap-fe'], // run order puts zap-fe first
      engineRuns: [
        engineRunFixture({
          id: 'a',
          engine: 'zap-fe',
          status: 'done',
          counts: { ...ZERO, high: 2 },
        }),
        engineRunFixture({
          id: 'b',
          engine: 'nuclei',
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: null,
          counts: ZERO,
        }),
      ],
      progress: null,
      now: NOW,
    })
    expect(hud.lanes.map((l) => l.state)).toEqual(['done', 'running'])
    expect(hud).toMatchObject({ active: 1, phase: 2, findings: 2 })
    // 15 of 60 budget minutes, square-rooted, capped: (1 + 0.5 * 0.9) / 2
    expect(hud.progress).toBeCloseTo((1 + 0.5 * RUNNING_PROGRESS_CAP) / 2)
  })

  it('running: the engine-reported percent and live matches take over when ahead', () => {
    const progress: EngineProgressView = {
      engine: 'nuclei',
      percent: 80,
      matched: 3,
      stage: 'signature',
    }
    const hud = deriveIntrusionHud({
      status: 'running',
      engines: ['nuclei'],
      engineRuns: [
        engineRunFixture({
          status: 'running',
          startedAt: '2026-01-01T00:14:00.000Z',
          finishedAt: null,
          counts: ZERO,
        }),
      ],
      progress,
      now: NOW,
    })
    expect(hud.progress).toBeCloseTo(0.8 * RUNNING_PROGRESS_CAP)
    expect(hud.lanes[0]!.findings).toBe(3)
    expect(hud.findings).toBe(3)
  })

  it('a running scan never reports its defenses fully broken, however long it takes', () => {
    const hud = deriveIntrusionHud({
      status: 'running',
      engines: ['nuclei'],
      engineRuns: [
        engineRunFixture({
          status: 'running',
          startedAt: '2025-01-01T00:00:00.000Z',
          finishedAt: null,
        }),
      ],
      progress: { engine: 'nuclei', percent: 100, matched: null, stage: null },
      now: NOW,
    })
    expect(hud.progress).toBeLessThan(1)
  })

  it('between engines the finished engine holds the link', () => {
    const hud = deriveIntrusionHud({
      status: 'running',
      engines: ['nuclei', 'zap-fe'],
      engineRuns: [engineRunFixture({ engine: 'zap-fe', status: 'done' })],
      progress: null,
      now: NOW,
    })
    expect(hud).toMatchObject({ active: 0, phase: 1, progress: 0.5 })
  })

  it('failed and skipped engines keep their own state on the rail', () => {
    const hud = deriveIntrusionHud({
      status: 'failed',
      engines: ['zap-fe', 'dalfox'],
      engineRuns: [
        engineRunFixture({ id: 'a', engine: 'zap-fe', status: 'skipped' }),
        engineRunFixture({ id: 'b', engine: 'dalfox', status: 'failed' }),
      ],
      progress: null,
      now: NOW,
    })
    expect(hud.lanes.map((l) => l.state)).toEqual(['skipped', 'failed'])
  })

  it('done → complete, failed → lost', () => {
    const base = {
      engines: ['nuclei' as const],
      engineRuns: [engineRunFixture()],
      progress: null,
      now: NOW,
    }
    expect(deriveIntrusionHud({ ...base, status: 'done' }).outcome).toBe('complete')
    expect(deriveIntrusionHud({ ...base, status: 'failed' }).outcome).toBe('lost')
  })
})

describe('finaleFor', () => {
  it('only an active → terminal transition seen on the page earns a finale', () => {
    expect(finaleFor('running', 'done')).toBe('complete')
    expect(finaleFor('queued', 'failed')).toBe('lost')
    expect(finaleFor(undefined, 'done')).toBeNull() // opened an already-finished scan
    expect(finaleFor('done', 'done')).toBeNull()
    expect(finaleFor('queued', 'running')).toBeNull()
  })
})
