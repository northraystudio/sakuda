import type { Engine } from '#shared/types/api'
import { runBoundary } from './boundary'
import { runDalfox } from './dalfox'
import { runNuclei } from './nuclei'
import type { EngineRunner } from './types'
import { runZapApi } from './zap/zapApi'
import { runZapFe } from './zap/zapFe'

export const engineRunners: Record<Engine, EngineRunner> = {
  nuclei: runNuclei,
  'zap-api': runZapApi,
  'zap-fe': runZapFe,
  dalfox: runDalfox,
  boundary: runBoundary,
}

/** Sorts and dedupes a scan's requested engines into their fixed run order
 * (shared with the page, which lists them the same way). */
export { ENGINE_ORDER, orderEngines } from '#shared/utils/engines'
