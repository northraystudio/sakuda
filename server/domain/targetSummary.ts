import type { EngineTargets, TargetRef, TargetSummary } from '#shared/types/api'
import { isActiveScanEnabled, type ActiveScanSite } from '#shared/utils/activeScan'
import { isSafeMethod } from './activeScan'
import {
  expandNucleiTargets,
  zapFeHashRouteTargets,
  zapFeRequestTargets,
  type ExpandedTarget,
  type NucleiTargetSite,
} from './nucleiTargets'

export type TargetSummarySite = NucleiTargetSite &
  ActiveScanSite & { openapiUrl: string | null; openapiJson: string | null }

const toRef = (t: ExpandedTarget): TargetRef => ({ method: t.method, base: t.base, path: t.path })
const isHashRoute = (t: ExpandedTarget) => t.url.includes('#')

/** Splits `all` into the lines `keep` selects and the rest — every engine
 * view is one such split, so a line is never in both columns. */
function split(all: ExpandedTarget[], keep: (t: ExpandedTarget) => boolean): EngineTargets {
  const targets: TargetRef[] = []
  const skipped: TargetRef[] = []
  for (const t of all) (keep(t) ? targets : skipped).push(toRef(t))
  return { available: true, targets, skipped }
}

/**
 * The read-only view the site page shows: the one saved list, and what each
 * engine will do with it on the next scan. Every rule here is the engine's
 * own (nuclei drops hash routes and replays non-GET only under active checks;
 * zapFe requests front-base lines via `zapFeRequestTargets` and probes hash
 * routes via `zapFeHashRouteTargets`; zap-api builds its generated doc from
 * active non-GET lines; dalfox takes GET server-reachable lines under active
 * checks; boundary takes the POST/PUT/PATCH lines under active checks) — restated over the same `expandNucleiTargets` result so the page
 * cannot drift from the adapters. Paths only: no host, no body shape.
 */
export function summarizeTargets(site: TargetSummarySite): TargetSummary {
  const expanded = expandNucleiTargets(site)
  const activeChecks = isActiveScanEnabled(site)
  // Unconfigured, nuclei falls back to the roots; the other engines see no
  // saved lines at all — same as their helpers, which return [] then.
  const saved = expanded.configured ? expanded.targets : []

  const nuclei = split(
    expanded.targets,
    (t) => !isHashRoute(t) && (t.method === 'GET' || activeChecks),
  )

  const feRequest = new Set(
    zapFeRequestTargets(expanded)
      .filter((t) => isSafeMethod(t.method) || activeChecks)
      .map((t) => `${t.method}|${t.url}`),
  )
  const feHash = new Set(activeChecks ? zapFeHashRouteTargets(expanded) : [])
  const zapFe = split(
    saved,
    (t) => feRequest.has(`${t.method}|${t.url}`) || (t.method === 'GET' && feHash.has(t.url)),
  )

  const zapApi = split(saved, (t) => activeChecks && t.method !== 'GET' && !isHashRoute(t))
  const hasOpenapi = !!site.openapiUrl || !!site.openapiJson
  const hasGenerated = zapApi.targets.length > 0
  const zapApiSource: TargetSummary['zapApiSource'] =
    hasOpenapi && hasGenerated
      ? 'openapi+generated'
      : hasOpenapi
        ? 'openapi'
        : hasGenerated
          ? 'generated'
          : 'none'
  zapApi.available = zapApiSource !== 'none'

  const dalfox = split(saved, (t) => activeChecks && t.method === 'GET' && !isHashRoute(t))
  dalfox.available = activeChecks

  // boundary writes bodies to POST/PUT/PATCH lines (those with a captured
  // shape) and to the pasted OpenAPI's JSON operations — never DELETE.
  const boundary = split(
    saved,
    (t) => activeChecks && ['POST', 'PUT', 'PATCH'].includes(t.method) && !isHashRoute(t),
  )
  boundary.available = activeChecks

  return {
    configured: expanded.configured,
    activeChecks,
    common: saved.map(toRef),
    excludedCount: expanded.excluded.length,
    engines: { nuclei, 'zap-fe': zapFe, 'zap-api': zapApi, dalfox, boundary },
    zapApiSource,
  }
}
