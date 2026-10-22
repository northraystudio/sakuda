import { afterEach, describe, expect, it } from 'vitest'
import { resolveChartPalette } from '~/utils/chart-palette'

const TOKENS = [
  '--color-sale-deep',
  '--color-sale',
  '--color-info',
  '--color-ink',
  '--color-accent-teal',
  '--color-accent-pink',
  '--color-stone',
  '--color-success',
  '--color-hairline-soft',
  '--color-mute',
] as const

describe('resolveChartPalette', () => {
  afterEach(() => {
    for (const t of TOKENS) document.documentElement.style.removeProperty(t)
  })

  it('reads role-based colors from CSS variables on documentElement (trimmed)', () => {
    const root = document.documentElement
    root.style.setProperty('--color-sale-deep', ' rgb(120, 7, 0) ')
    root.style.setProperty('--color-sale', 'rgb(211, 0, 5)')
    root.style.setProperty('--color-info', 'rgb(17, 81, 255)')
    root.style.setProperty('--color-ink', 'rgb(17, 17, 17)')
    root.style.setProperty('--color-accent-teal', 'rgb(10, 114, 129)')
    root.style.setProperty('--color-accent-pink', 'rgb(237, 26, 160)')
    root.style.setProperty('--color-stone', 'rgb(158, 158, 160)')
    root.style.setProperty('--color-success', 'rgb(0, 125, 72)')
    root.style.setProperty('--color-hairline-soft', 'rgb(229, 229, 229)')
    root.style.setProperty('--color-mute', 'rgb(112, 112, 114)')

    expect(resolveChartPalette()).toEqual({
      grid: 'rgb(229, 229, 229)',
      text: 'rgb(112, 112, 114)',
      severity: {
        critical: 'rgb(120, 7, 0)',
        high: 'rgb(211, 0, 5)',
        medium: 'rgb(17, 81, 255)',
      },
      engines: {
        nuclei: 'rgb(17, 17, 17)',
        'zap-api': 'rgb(10, 114, 129)',
        'zap-fe': 'rgb(158, 158, 160)',
        dalfox: 'rgb(237, 26, 160)',
        boundary: 'rgb(0, 125, 72)',
      },
      diff: {
        new: 'rgb(211, 0, 5)',
        persisting: 'rgb(158, 158, 160)',
        resolved: 'rgb(0, 125, 72)',
      },
    })
  })

  it('falls back to the DESIGN.md hex values when a token is unset (e.g. no stylesheet in tests)', () => {
    expect(resolveChartPalette()).toEqual({
      grid: '#e5e5e5',
      text: '#707072',
      severity: {
        critical: '#780700',
        high: '#d30005',
        medium: '#1151ff',
      },
      engines: {
        nuclei: '#111111',
        'zap-api': '#0a7281',
        'zap-fe': '#9e9ea0',
        dalfox: '#ed1aa0',
        boundary: '#007d48',
      },
      diff: {
        new: '#d30005',
        persisting: '#9e9ea0',
        resolved: '#007d48',
      },
    })
  })
})
