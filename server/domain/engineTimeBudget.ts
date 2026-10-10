import type { Engine, EngineTimeBudget, EngineTimeBudgetPart, SitePublic } from '#shared/types/api'
import type { Env } from '../config/env'
import { effectiveNucleiMaxMinutes, type NucleiLimitsSite } from './nucleiLimits'

/** ZAP passive-scan tail every ZAP run waits for after its active work. */
export const ZAP_PASSIVE_MAX_MINUTES = 5
/** Wall-clock budget for the whole zap-fe DOM XSS probe. */
export const DOM_XSS_PROBE_BUDGET_MINUTES = 10

export type TimeBudgetSite = Pick<SitePublic, 'zapApiMaxMinutes' | 'zapFeSpiderMaxMinutes'> &
  NucleiLimitsSite
export interface TimeBudgetEnv {
  /** SAKUDA_NUCLEI_MAX_MINUTES; a site's `nucleiMaxMinutes` overrides it. */
  nucleiMaxMinutes: number
  dalfoxMaxMinutes: number
  /** The httpx liveness probe that runs ahead of nuclei's phases (#91). */
  httpxMaxMinutes: number
  engineGraceMinutes: number
}
export interface TimeBudgetFlags {
  /** Active checks are on for this run (see `isActiveScanEnabled`). */
  activeScan: boolean
  /** zap-fe only: the run includes the DOM XSS probe (the site has hash routes). */
  domXssProbe: boolean
}

/** The env fields the budget depends on, picked from the validated env. */
export function timeBudgetEnv(
  env: Pick<Env, 'nuclei' | 'httpx' | 'dalfox' | 'engineGraceMinutes'>,
): TimeBudgetEnv {
  return {
    nucleiMaxMinutes: env.nuclei.maxMinutes,
    httpxMaxMinutes: env.httpx.maxMinutes,
    dalfoxMaxMinutes: env.dalfox.maxMinutes,
    engineGraceMinutes: env.engineGraceMinutes,
  }
}

/**
 * The single source of truth for how long an engine run may take (#84).
 * Each engine derives its process timeout from `totalMinutes` and records
 * the whole budget in `meta.timeBudget`, and the scan API reads that back,
 * so what the page shows as the limit is exactly what the runner enforced.
 *
 * - nuclei: the httpx liveness probe's cap (`SAKUDA_HTTPX_MAX_MINUTES`) plus
 *   its own deadline — the site's `nucleiMaxMinutes`, else
 *   `SAKUDA_NUCLEI_MAX_MINUTES` — shared by every phase; no grace, the engine
 *   stops itself.
 * - zap-api: the site's active-scan cap + the passive tail + the grace ZAP
 *   gets to shut down.
 * - zap-fe: two spider runs (traditional + ajax) + the active scan under
 *   active checks (capped by the same site value as zap-api) + the DOM XSS
 *   probe when hash routes exist + passive tail + grace.
 */
export function engineTimeBudget(
  engine: Engine,
  site: TimeBudgetSite,
  env: TimeBudgetEnv,
  flags: TimeBudgetFlags,
): EngineTimeBudget {
  const parts: EngineTimeBudgetPart[] = []
  switch (engine) {
    case 'nuclei': {
      const nuclei = effectiveNucleiMaxMinutes(site, env.nucleiMaxMinutes)
      parts.push(
        { label: 'httpx probe (SAKUDA_HTTPX_MAX_MINUTES)', minutes: env.httpxMaxMinutes },
        {
          label:
            nuclei.source === 'site'
              ? 'nuclei (site setting)'
              : 'nuclei (SAKUDA_NUCLEI_MAX_MINUTES)',
          minutes: nuclei.minutes,
        },
      )
      break
    }
    case 'zap-api':
      parts.push(
        { label: 'active scan', minutes: site.zapApiMaxMinutes },
        { label: 'passive scan', minutes: ZAP_PASSIVE_MAX_MINUTES },
        { label: 'shutdown grace', minutes: env.engineGraceMinutes },
      )
      break
    case 'zap-fe':
      parts.push({ label: 'spider (traditional + ajax)', minutes: site.zapFeSpiderMaxMinutes * 2 })
      if (flags.activeScan) parts.push({ label: 'active scan', minutes: site.zapApiMaxMinutes })
      if (flags.domXssProbe)
        parts.push({ label: 'DOM XSS probe', minutes: DOM_XSS_PROBE_BUDGET_MINUTES })
      parts.push(
        { label: 'passive scan', minutes: ZAP_PASSIVE_MAX_MINUTES },
        { label: 'shutdown grace', minutes: env.engineGraceMinutes },
      )
      break
    case 'dalfox':
      // One self-limited run: dalfox enforces its own per-target scan timeout
      // derived from this budget, plus the shutdown grace the process gets.
      parts.push(
        { label: 'dalfox (SAKUDA_DALFOX_MAX_MINUTES)', minutes: env.dalfoxMaxMinutes },
        { label: 'shutdown grace', minutes: env.engineGraceMinutes },
      )
      break
    default: {
      const exhaustive: never = engine
      return exhaustive
    }
  }
  return { parts, totalMinutes: parts.reduce((sum, p) => sum + p.minutes, 0) }
}

function isBudgetPart(v: unknown): v is EngineTimeBudgetPart {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { label?: unknown }).label === 'string' &&
    typeof (v as { minutes?: unknown }).minutes === 'number'
  )
}

/** The budget an engine recorded in its run `meta`, or null when the run
 * predates the recording (or the value is not the expected shape). */
export function recordedTimeBudget(meta: Record<string, unknown>): EngineTimeBudget | null {
  const v = meta.timeBudget
  if (typeof v !== 'object' || v === null) return null
  const { parts, totalMinutes } = v as { parts?: unknown; totalMinutes?: unknown }
  if (!Array.isArray(parts) || !parts.every(isBudgetPart) || typeof totalMinutes !== 'number')
    return null
  return { parts, totalMinutes }
}
