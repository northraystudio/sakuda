import type { Engine } from '#shared/types/api'

/** 1-bit pixel art: one string per row, `#` = lit. Pre-rendered once per
 * color by the component, then blitted with drawImage every frame. */
export type Bitmap = readonly string[]

/** Each engine's craft, pointing at the target; the silhouette tells the
 * engines apart even without color. */
export const ENGINE_ICONS: Record<Engine, Bitmap> = {
  // Wide-winged scanner for both ZAP passes.
  'zap-api': ['##....', '.##...', '#####.', '######', '#####.', '.##...', '##....'],
  'zap-fe': ['##....', '.##...', '#####.', '######', '#####.', '.##...', '##....'],
  // Narrow, pointed interceptor for the XSS pass.
  dalfox: ['#.....', '###...', '.####.', '######', '.####.', '###...', '#.....'],
  // Heavy block for the template barrage.
  nuclei: ['###...', '####..', '.#####', '.#####', '.#####', '####..', '###...'],
}

/** A rack server with three units. */
export const SERVER: Bitmap = [
  '##########',
  '#........#',
  '#.##.....#',
  '#........#',
  '##########',
  '#........#',
  '#.##.....#',
  '#........#',
  '##########',
  '#........#',
  '#.##.....#',
  '#........#',
  '##########',
]

/** Short rail labels; the full names live in `ENGINE_LABELS`. */
export const ENGINE_SHORT_LABELS: Record<Engine, string> = {
  'zap-api': 'ZAP API',
  'zap-fe': 'ZAP Frontend',
  dalfox: 'Dalfox',
  nuclei: 'Nuclei',
}

/** Colors as design-token CSS variables (DESIGN.md `colors.*`). */
export const ENGINE_COLOR_TOKENS: Record<Engine, string> = {
  nuclei: '--color-success-bright',
  'zap-api': '--color-info',
  'zap-fe': '--color-info',
  dalfox: '--color-sale',
}
export const QUEUED_COLOR_TOKEN = '--color-ash'
export const MUTED_TEXT_TOKEN = '--color-mute'
export const TEXT_TOKEN = '--color-on-primary'
export const SHIELD_COLOR_TOKEN = '--color-success-bright'
export const TERMINAL_COLOR_TOKEN = '--color-success-bright'
export const HIT_COLOR_TOKEN = '--color-accent-pink'
export const FAIL_COLOR_TOKEN = '--color-sale'
export const SERVER_COLOR_TOKEN = '--color-hairline'
