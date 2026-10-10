import type { SitePublic } from '#shared/types/api'
import type { Env } from '../config/env'

/** The site's nuclei overrides. Partial: a scan's site snapshot taken before
 * #10 has neither field, which must read as "no override". */
export type NucleiLimitsSite = Partial<Pick<SitePublic, 'nucleiMaxMinutes' | 'nucleiConcurrency'>>

export interface NucleiMaxMinutes {
  minutes: number
  /** Where the value came from — shown in the time-budget label. */
  source: 'site' | 'env'
}

export interface NucleiLimits {
  maxMinutes: NucleiMaxMinutes
  concurrency: number
}

// The single place nuclei's limits are resolved (#10): the site's value when
// set, else the env value (SAKUDA_NUCLEI_MAX_MINUTES / SAKUDA_NUCLEI_CONCURRENCY,
// whose own defaults live in `config/env`).

export function effectiveNucleiMaxMinutes(
  site: NucleiLimitsSite,
  envMaxMinutes: number,
): NucleiMaxMinutes {
  const siteMinutes = site.nucleiMaxMinutes ?? null
  return siteMinutes === null
    ? { minutes: envMaxMinutes, source: 'env' }
    : { minutes: siteMinutes, source: 'site' }
}

export function effectiveNucleiLimits(
  site: NucleiLimitsSite,
  env: Pick<Env['nuclei'], 'maxMinutes' | 'concurrency'>,
): NucleiLimits {
  return {
    maxMinutes: effectiveNucleiMaxMinutes(site, env.maxMinutes),
    concurrency: site.nucleiConcurrency ?? env.concurrency,
  }
}
