import type { RiskTag, SitePublic } from '#shared/types/api'
import { RISK_TAGS } from '#shared/types/api'
import type { TargetMethod } from '#shared/utils/nucleiPaths'
import { isActiveScanEnabled, type ActiveScanSite } from '#shared/utils/activeScan'

/**
 * HTTP methods that only read: replaying one cannot change the target's
 * state, so it needs no active-scan opt-in. The mutating verbs
 * (POST/PUT/PATCH/DELETE) do — an engine that replays one must gate it on
 * {@link isActiveScanEnabled}. This is the classification only; the gate
 * itself stays `isActiveScanEnabled`, added where a dangerous method is
 * actually dispatched (Epic #41 PR3/PR4), so the two decisions do not fuse.
 */
export const SAFE_METHODS: readonly TargetMethod[] = ['GET', 'HEAD', 'OPTIONS']

export function isSafeMethod(method: TargetMethod): boolean {
  return SAFE_METHODS.includes(method)
}

// The gate itself lives in shared/utils so the UI warns from the same
// definition the engines act on; re-exported here so engine code keeps one
// import for the whole active-scan vocabulary.
export { isActiveScanEnabled, type ActiveScanSite } from '#shared/utils/activeScan'

/** The gate's fields plus the risk-group opt-ins the nuclei adapter reads. */
export type RiskTagSite = ActiveScanSite & Pick<SitePublic, 'nucleiEnabledRiskTags'>

/**
 * Extra `-tags` each risk toggle must add for the templates it unlocks to
 * actually load. Measured against nuclei-templates v10.4.8, re-checked on v10.5.1: dropping a tag
 * from `-exclude-tags` alone is not enough when the templates it unlocks also
 * sit outside the base `-tags` allow-list (see {@link riskExcludeTags}).
 *
 * - `intrusive` — none; the `http/cves/*` checks it unlocks already match the
 *   base allow-list, so they load once the exclusion is lifted.
 * - `fuzz` — `cmdi,rce`; the command-injection / RCE DAST templates carry
 *   those tags and would otherwise be filtered out by `-tags`.
 * - `dos` — `dos`; DoS templates match no base tag, so the tag must be added.
 */
const RISK_EXTRA_TAGS: Record<RiskTag, readonly string[]> = {
  intrusive: [],
  fuzz: ['cmdi', 'rce'],
  dos: ['dos'],
}

/**
 * The risk-template groups this scan may actually enable: the site's selected
 * tags, but only when active checks are on. With the opt-in off the result is
 * always empty — a stale `nucleiEnabledRiskTags` can never re-open the
 * excluded groups on its own. Returned in the fixed {@link RISK_TAGS} order.
 */
export function effectiveRiskTags(site: RiskTagSite): RiskTag[] {
  if (!isActiveScanEnabled(site)) return []
  return RISK_TAGS.filter((t) => site.nucleiEnabledRiskTags.includes(t))
}

/** The `-exclude-tags` value for a run: the three risk tags minus the ones
 * enabled. Empty `enabled` returns all three — the default, unchanged. */
export function riskExcludeTags(enabled: readonly RiskTag[]): string[] {
  return RISK_TAGS.filter((t) => !enabled.includes(t))
}

/** Tags that must be added to `-tags` so the enabled groups' templates load
 * (see {@link RISK_EXTRA_TAGS}). Deduped; empty when nothing is enabled. */
export function riskExtraTags(enabled: readonly RiskTag[]): string[] {
  return [...new Set(enabled.flatMap((t) => RISK_EXTRA_TAGS[t]))]
}

/** How many target URLs carry query parameters — the only inputs nuclei's
 * DAST templates can fuzz. Zero with active checks on means the run will
 * silently do no injection testing, which the caller should warn about. */
export function countParameterizedUrls(urls: string[]): number {
  return urls.filter((u) => URL.canParse(u) && new URL(u).search.length > 1).length
}

/** Placeholder value given to an empty-valued query parameter so nuclei's
 * DAST fuzzer has a seed to mutate (see {@link seedEmptyQueryValues}). */
export const FUZZ_SEED_VALUE = '1'

/**
 * Gives every empty-valued query parameter a placeholder value so nuclei's
 * DAST fuzzer will actually mutate it. nuclei skips a parameter whose value
 * is empty (`?q=`), so a target discovery saved as `/search?q=` — the common
 * shape — would be fuzzed on nothing. `/search?q=` becomes `/search?q=1`;
 * a parameter that already has a value is left untouched.
 *
 * Applied only to the transient targets file of an *active* run, never to the
 * site's saved target list or to discovery output — it changes what this one
 * scan sends, not what the site stores. A URL that does not parse is returned
 * unchanged rather than dropped (the engine still reports on it).
 */
export function seedEmptyQueryValues(urls: string[], seed: string = FUZZ_SEED_VALUE): string[] {
  return urls.map((u) => {
    if (!URL.canParse(u)) return u
    const parsed = new URL(u)
    if (parsed.search.length <= 1) return u // no query params at all
    let changed = false
    for (const key of [...parsed.searchParams.keys()]) {
      if (parsed.searchParams.get(key) === '') {
        parsed.searchParams.set(key, seed)
        changed = true
      }
    }
    return changed ? parsed.toString() : u
  })
}
