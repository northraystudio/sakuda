import type { ChartPalette } from './chart-config'

/** DESIGN.md hex fallbacks (app/assets/css/tokens.css) — used when a CSS
 * variable resolves empty, e.g. in tests with no stylesheet loaded. */
const FALLBACKS = {
  saleDeep: '#780700',
  sale: '#d30005',
  info: '#1151ff',
  ink: '#111111',
  accentTeal: '#0a7281',
  accentPink: '#ed1aa0',
  stone: '#9e9ea0',
  success: '#007d48',
  hairlineSoft: '#e5e5e5',
  mute: '#707072',
}

/** Resolves the chart color palette from CSS custom properties. Canvas
 * rendering doesn't inherit CSS, so colors must be read and passed in as
 * literal values. Client-only: call from within `<ClientOnly>`. */
export function resolveChartPalette(): ChartPalette {
  const styles = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback

  const saleDeep = token('--color-sale-deep', FALLBACKS.saleDeep)
  const sale = token('--color-sale', FALLBACKS.sale)
  const info = token('--color-info', FALLBACKS.info)
  const ink = token('--color-ink', FALLBACKS.ink)
  const accentTeal = token('--color-accent-teal', FALLBACKS.accentTeal)
  const stone = token('--color-stone', FALLBACKS.stone)
  const accentPink = token('--color-accent-pink', FALLBACKS.accentPink)
  const success = token('--color-success', FALLBACKS.success)

  return {
    grid: token('--color-hairline-soft', FALLBACKS.hairlineSoft),
    text: token('--color-mute', FALLBACKS.mute),
    severity: { critical: saleDeep, high: sale, medium: info },
    engines: {
      nuclei: ink,
      'zap-api': accentTeal,
      'zap-fe': stone,
      dalfox: accentPink,
      boundary: success,
    },
    diff: { new: sale, persisting: stone, resolved: success },
  }
}
