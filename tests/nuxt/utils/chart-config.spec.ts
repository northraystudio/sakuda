import { describe, expect, it } from 'vitest'
import {
  MIN_TREND_POINTS,
  buildDiffTrendConfig,
  buildEngineCountConfig,
  buildSeverityStackConfig,
  hasTrendData,
  historyLabel,
  type ChartPalette,
} from '~/utils/chart-config'
import { historyPointFixture } from '../helpers/fixtures'

const palette: ChartPalette = {
  grid: 'grid-color',
  text: 'text-color',
  severity: { critical: 'c-color', high: 'h-color', medium: 'm-color' },
  engines: {
    nuclei: 'nuclei-color',
    'zap-api': 'zap-api-color',
    'zap-fe': 'zap-fe-color',
    dalfox: 'dalfox-color',
  },
  diff: { new: 'new-color', persisting: 'persisting-color', resolved: 'resolved-color' },
}

describe('historyLabel', () => {
  it('formats finishedAt as UTC "YYYY-MM-DD HH:MM"', () => {
    const point = historyPointFixture({
      createdAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-07-02T13:45:30.000Z',
    })
    expect(historyLabel(point)).toBe('2026-07-02 13:45')
  })

  it('falls back to createdAt when finishedAt is null', () => {
    const point = historyPointFixture({
      createdAt: '2026-07-02T13:45:30.000Z',
      finishedAt: null,
    })
    expect(historyLabel(point)).toBe('2026-07-02 13:45')
  })
})

describe('hasTrendData', () => {
  it.each([
    [0, false],
    [1, false],
    [2, true],
  ])('history of %d point(s) → %s', (n, expected) => {
    expect(hasTrendData(Array.from({ length: n }, () => historyPointFixture()))).toBe(expected)
  })

  it('exposes MIN_TREND_POINTS as 2', () => {
    expect(MIN_TREND_POINTS).toBe(2)
  })
})

describe('buildSeverityStackConfig', () => {
  it('builds 3 stacked datasets (critical/high/medium) with palette colors', () => {
    const point = historyPointFixture({
      counts: { critical: 1, high: 2, medium: 3, low: 4, info: 5 },
    })
    const config = buildSeverityStackConfig([point], palette)

    expect(config.type).toBe('bar')
    expect(config.data.labels).toEqual([historyLabel(point)])
    expect(config.data.datasets).toHaveLength(3)
    expect(config.data.datasets.map((d) => d.label)).toEqual(['Critical', 'High', 'Medium'])
    expect(config.data.datasets.map((d) => d.data[0])).toEqual([1, 2, 3])
    expect(config.data.datasets.map((d) => d.backgroundColor)).toEqual([
      'c-color',
      'h-color',
      'm-color',
    ])
    expect(config.data.datasets.every((d) => d.stack === 'severity')).toBe(true)
    expect(config.options?.scales?.x).toMatchObject({ stacked: true })
    expect(config.options?.scales?.y).toMatchObject({ stacked: true })
    expect(config.options?.maintainAspectRatio).toBe(false)
    expect(config.options?.plugins?.legend?.display).toBe(true)
  })
})

describe('buildEngineCountConfig', () => {
  it('builds one dataset per engine, in ENGINES order, with reportedTotal per point', () => {
    const point = historyPointFixture({
      engines: {
        nuclei: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
        'zap-api': { critical: 0, high: 2, medium: 1, low: 0, info: 0 },
      },
    })
    const config = buildEngineCountConfig([point], palette)

    expect(config.data.datasets.map((d) => d.label)).toEqual([
      'Nuclei',
      'ZAP API (active)',
      'ZAP Frontend (baseline)',
      'Dalfox (XSS)',
    ])
    expect(config.data.datasets.map((d) => d.data[0])).toEqual([1, 3, 0, 0])
    expect(config.data.datasets.map((d) => d.backgroundColor)).toEqual([
      'nuclei-color',
      'zap-api-color',
      'zap-fe-color',
      'dalfox-color',
    ])
  })

  it('uses 0 for an engine absent from a point', () => {
    const point = historyPointFixture({ engines: {} })
    const config = buildEngineCountConfig([point], palette)
    expect(config.data.datasets.map((d) => d.data[0])).toEqual([0, 0, 0, 0])
  })
})

describe('buildDiffTrendConfig', () => {
  it('stacks new/persisting positively and resolved as negative values', () => {
    const point = historyPointFixture({
      diff: { new: 2, persisting: 5, resolved: 3, suppressed: 0 },
    })
    const config = buildDiffTrendConfig([point], palette)

    expect(config.data.datasets.map((d) => d.label)).toEqual(['New', 'Persisting', 'Resolved'])
    expect(config.data.datasets.map((d) => d.data[0])).toEqual([2, 5, -3])
    expect(config.data.datasets.map((d) => d.backgroundColor)).toEqual([
      'new-color',
      'persisting-color',
      'resolved-color',
    ])
    expect(config.data.datasets.every((d) => d.stack === 'diff')).toBe(true)
  })

  it('uses null for every series when diff is null', () => {
    const point = historyPointFixture({ diff: null })
    const config = buildDiffTrendConfig([point], palette)
    expect(config.data.datasets.map((d) => d.data[0])).toEqual([null, null, null])
  })
})
