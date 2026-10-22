import type { Engine } from '../types/api'

export const ENGINES = ['nuclei', 'zap-api', 'zap-fe', 'dalfox', 'boundary'] as const
export const ENGINE_LABELS: Record<Engine, string> = {
  nuclei: 'Nuclei',
  'zap-api': 'ZAP API (active)',
  'zap-fe': 'ZAP Frontend (baseline)',
  dalfox: 'Dalfox (XSS)',
  boundary: 'Boundary (input validation)',
}
export function isEngine(v: unknown): v is Engine {
  return typeof v === 'string' && (ENGINES as readonly string[]).includes(v)
}

/** The order the scan runner executes engines in — the short API scan
 * first, the crawl second, the bounded XSS pass third, the write-side input
 * validation probe fourth, nuclei last — and the order the page lists them.
 * dalfox runs after zap-fe (so the crawl's reached URLs are already saved);
 * boundary follows it so the records it creates cannot disturb the XSS pass,
 * and both run before nuclei. */
export const ENGINE_ORDER: readonly Engine[] = ['zap-api', 'zap-fe', 'dalfox', 'boundary', 'nuclei']
export function orderEngines(engines: readonly Engine[]): Engine[] {
  return ENGINE_ORDER.filter((x) => engines.includes(x))
}
