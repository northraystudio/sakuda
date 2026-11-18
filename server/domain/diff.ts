import type { Engine, UnverifiedReason } from '#shared/types/api'
import { normalizeUrlForFingerprint } from './fingerprint'

export interface DiffCounts {
  new: number
  persisting: number
  resolved: number
  suppressed: number
}

/** Set semantics over fingerprints: `new` = in current not previous;
 * `persisting` = in both; `resolved` = in previous not current — every
 * fingerprint that is gone, before {@link splitGoneFindings} sets aside the
 * ones the current scan did not check. A fingerprint
 * that would be new but is in `suppressed` (triaged as false-positive /
 * accepted, #18) counts as `suppressed` instead. Counts are of unique
 * fingerprints, so duplicate entries in either iterable collapse. */
export function diffFingerprints(
  previous: Iterable<string>,
  current: Iterable<string>,
  suppressed: ReadonlySet<string> = new Set(),
): DiffCounts {
  const previousSet = new Set(previous)
  const currentSet = new Set(current)

  let newCount = 0
  let persisting = 0
  let suppressedCount = 0
  for (const fingerprint of currentSet) {
    if (previousSet.has(fingerprint)) persisting++
    else if (suppressed.has(fingerprint)) suppressedCount++
    else newCount++
  }

  let resolved = 0
  for (const fingerprint of previousSet) {
    if (!currentSet.has(fingerprint)) resolved++
  }

  return { new: newCount, persisting, resolved, suppressed: suppressedCount }
}

/** The URLs one engine run requested, as {@link reachKey}s. `truncated` means
 * the record was cut at its cap, so a URL missing from it may still have been
 * requested. */
export interface ReachRecord {
  urls: ReadonlySet<string>
  truncated: boolean
}

/** What the current scan actually looked at — the basis for calling a
 * finding that is gone "resolved" rather than "not checked". */
export interface ScanCoverage {
  /** Engines whose run finished (`done`) in the current scan. */
  doneEngines: ReadonlySet<Engine>
  /** Only for engines judged by URL as well (zap-fe, whose crawl decides what
   * it sees): the record of what the run requested, or null when the run left
   * none. An engine without an entry is judged by `doneEngines` alone. */
  reach: ReadonlyMap<Engine, ReachRecord | null>
}

/** A URL as compared for reach: scheme, host and path only (as in the
 * fingerprint — a query value is never kept), minus one trailing slash so
 * `/dash/` and `/dash` are the same page. */
export function reachKey(url: string): string {
  const normalized = normalizeUrlForFingerprint(url)
  if (!URL.canParse(normalized)) return normalized
  return new URL(normalized).pathname.length > 1 ? normalized.replace(/\/$/, '') : normalized
}

/** `resolved`, or why the current scan cannot say so. */
export function classifyGoneFinding(
  finding: { engine: Engine; url: string },
  coverage: ScanCoverage,
): 'resolved' | UnverifiedReason {
  if (!coverage.doneEngines.has(finding.engine)) return 'engine-not-run'
  if (!coverage.reach.has(finding.engine)) return 'resolved'
  const record = coverage.reach.get(finding.engine)
  if (!record) return 'reach-unknown'
  if (record.urls.has(reachKey(finding.url))) return 'resolved'
  return record.truncated ? 'reach-unknown' : 'url-not-reached'
}

/** Splits the previous scan's findings that are absent from the current one
 * into resolved and unverified (#89). One entry per fingerprint (the first
 * row wins), so the lengths are counts of unique fingerprints like
 * {@link diffFingerprints}. */
export function splitGoneFindings<T extends { engine: Engine; url: string; fingerprint: string }>(
  previous: readonly T[],
  current: ReadonlySet<string>,
  coverage: ScanCoverage,
): { resolved: T[]; unverified: Array<{ finding: T; reason: UnverifiedReason }> } {
  const seen = new Set<string>()
  const resolved: T[] = []
  const unverified: Array<{ finding: T; reason: UnverifiedReason }> = []
  for (const finding of previous) {
    if (current.has(finding.fingerprint) || seen.has(finding.fingerprint)) continue
    seen.add(finding.fingerprint)
    const verdict = classifyGoneFinding(finding, coverage)
    if (verdict === 'resolved') resolved.push(finding)
    else unverified.push({ finding, reason: verdict })
  }
  return { resolved, unverified }
}

/** Cap on the reach record an engine stores per run. */
export const MAX_REACH_URLS = 2000

/** The reach record for a list of requested URLs: unique {@link reachKey}s in
 * first-seen order, cut at `max`. */
export function buildReachRecord(
  urls: readonly string[],
  max: number = MAX_REACH_URLS,
): { urls: string[]; truncated: boolean } {
  const keys = [...new Set(urls.map(reachKey))]
  return { urls: keys.slice(0, max), truncated: keys.length > max }
}
