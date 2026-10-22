import type { Engine, EngineRunView } from '#shared/types/api'
import {
  code,
  fmtDuration,
  metaBoolean,
  metaNumber,
  metaRecord,
  metaString,
  metaStringArray,
  text,
} from './markdownHelpers'

/** Renders the `| Item | Value |` metadata table for one engine run: the
 * generic exit/duration rows shared by every engine, followed by rows built
 * from the engine-specific `meta` fields each engine writes (see
 * server/engines/{nuclei,zap}/*). */
export function engineMetaTable(run: EngineRunView): string[] {
  const rows = ['| Item | Value |', '|---|---|', `| Exit code | ${run.exitCode ?? '—'} |`]
  if (run.signal) rows.push(`| Signal | ${text(run.signal)} |`)
  rows.push(`| Duration | ${fmtDuration(metaNumber(run.meta, 'durationSec'))} |`)
  if (metaBoolean(run.meta, 'timedOut')) rows.push('| Timed out | Yes |')
  rows.push(...engineSpecificRows(run.engine, run.meta))
  return rows
}

function engineSpecificRows(engine: Engine, meta: Record<string, unknown>): string[] {
  switch (engine) {
    case 'nuclei':
      return nucleiRows(meta)
    case 'zap-fe':
      return zapRows(meta, true)
    case 'zap-api':
      return zapRows(meta, false)
    case 'dalfox':
      return dalfoxRows(meta)
    case 'boundary':
      return boundaryRows(meta)
    default: {
      const exhaustive: never = engine
      return exhaustive
    }
  }
}

function nucleiRows(meta: Record<string, unknown>): string[] {
  const rows: string[] = []
  const urlCount = metaNumber(meta, 'urlCount')
  if (urlCount !== undefined) rows.push(`| Target URLs | ${urlCount} |`)
  const excludedUrls = metaStringArray(meta, 'excludedUrls')
  if (excludedUrls) rows.push(`| Excluded URLs | ${excludedUrls.length} |`)
  const tags = metaStringArray(meta, 'tags')
  if (tags && tags.length > 0) rows.push(`| Tags | ${code(tags.join(','))} |`)
  const rateLimit = metaNumber(meta, 'rateLimit')
  if (rateLimit !== undefined) rows.push(`| Rate limit | ${rateLimit} req/s |`)
  const concurrency = metaNumber(meta, 'concurrency')
  if (concurrency !== undefined) rows.push(`| Concurrency | ${concurrency} |`)
  if (metaBoolean(meta, 'activeScan')) {
    rows.push('| Active checks (DAST) | Yes |')
    const parameterizedUrlCount = metaNumber(meta, 'parameterizedUrlCount')
    if (parameterizedUrlCount !== undefined)
      rows.push(`| Fuzzable URLs (with query params) | ${parameterizedUrlCount} |`)
    const riskTags = metaStringArray(meta, 'riskTags')
    if (riskTags && riskTags.length > 0) rows.push(`| Risk groups | ${code(riskTags.join(','))} |`)
  }
  const stats = metaRecord(meta, 'stats')
  if (stats) {
    const templates = metaString(stats, 'templates')
    if (templates) rows.push(`| Templates scanned | ${text(templates)} |`)
    const requests = metaString(stats, 'requests')
    if (requests) rows.push(`| Requests sent | ${text(requests)} |`)
    const errors = metaString(stats, 'errors')
    if (errors) rows.push(`| Errors | ${text(errors)} |`)
    const rps = metaString(stats, 'rps')
    if (rps) rows.push(`| Avg RPS | ${text(rps)} |`)
  }
  return rows
}

function dalfoxRows(meta: Record<string, unknown>): string[] {
  const rows: string[] = []
  if (meta.skipped === true) {
    rows.push('| Skipped | Active injection checks are off |')
    return rows
  }
  const urlCount = metaNumber(meta, 'urlCount')
  if (urlCount !== undefined) rows.push(`| Target URLs | ${urlCount} |`)
  const rateLimit = metaNumber(meta, 'rateLimit')
  if (rateLimit !== undefined) rows.push(`| Rate limit | ${rateLimit} req/s |`)
  const concurrency = metaNumber(meta, 'concurrency')
  if (concurrency !== undefined) rows.push(`| Concurrency | ${concurrency} |`)
  const maxTargets = metaNumber(meta, 'maxTargets')
  if (maxTargets !== undefined) rows.push(`| Max targets | ${maxTargets} |`)
  const totalRequests = metaNumber(meta, 'totalRequests')
  if (totalRequests !== undefined) rows.push(`| Requests sent | ${totalRequests} |`)
  if (metaBoolean(meta, 'incomplete')) rows.push('| Incomplete scan | Yes |')
  if (metaBoolean(meta, 'unavailable')) {
    const n = metaNumber(meta, 'unreachableTargets')
    rows.push(`| Target unavailable | Yes${n !== undefined ? ` (${n} unreachable)` : ''} |`)
  }
  return rows
}

function boundaryRows(meta: Record<string, unknown>): string[] {
  const rows: string[] = []
  if (meta.skipped === true) {
    rows.push('| Skipped | Active injection checks are off |')
    return rows
  }
  const operations = metaNumber(meta, 'operations')
  if (operations !== undefined) rows.push(`| Write operations | ${operations} |`)
  const cases = metaNumber(meta, 'casesPlanned')
  if (cases !== undefined) rows.push(`| Cases planned | ${cases} |`)
  const requests = metaNumber(meta, 'requestsSent')
  if (requests !== undefined) rows.push(`| Requests sent | ${requests} |`)
  const accepted = metaNumber(meta, 'accepted')
  if (accepted !== undefined) rows.push(`| Accepted (stored as sent) | ${accepted} |`)
  const rejected = metaNumber(meta, 'rejected')
  if (rejected !== undefined) rows.push(`| Rejected (4xx/5xx) | ${rejected} |`)
  const coerced = metaNumber(meta, 'coerced')
  if (coerced !== undefined) rows.push(`| Coerced | ${coerced} |`)
  const unverifiable = metaNumber(meta, 'unverifiable')
  if (unverifiable !== undefined) rows.push(`| Not verifiable | ${unverifiable} |`)
  if (metaBoolean(meta, 'truncated'))
    rows.push('| Stopped early | Yes (request cap or time budget) |')
  return rows
}

function zapRows(meta: Record<string, unknown>, isFrontend: boolean): string[] {
  const rows: string[] = []
  const zapVersion = metaString(meta, 'zapVersion')
  if (zapVersion) rows.push(`| ZAP version | ${text(zapVersion)} |`)
  if (isFrontend) {
    // `seedUrls` since the crawl starts became a list; `seedUrl` for scans
    // recorded before that.
    const seedUrls = metaStringArray(meta, 'seedUrls') ?? []
    const legacySeedUrl = metaString(meta, 'seedUrl')
    if (seedUrls.length > 0) rows.push(`| Seed URLs | ${seedUrls.map(code).join(', ')} |`)
    else if (legacySeedUrl) rows.push(`| Seed URL | ${code(legacySeedUrl)} |`)
    const spider = metaString(meta, 'spider')
    if (spider) rows.push(`| Spider | ${text(spider)} |`)
    const spiderMaxMinutes = metaNumber(meta, 'spiderMaxMinutes')
    if (spiderMaxMinutes !== undefined) rows.push(`| Spider max minutes | ${spiderMaxMinutes} |`)
    if (metaBoolean(meta, 'activeScan')) {
      const activeScanMaxMinutes = metaNumber(meta, 'activeScanMaxMinutes')
      const cap = activeScanMaxMinutes !== undefined ? ` (max ${activeScanMaxMinutes} min)` : ''
      rows.push(`| Active scan | Yes${cap} |`)
    }
    const hashRouteCount = metaNumber(meta, 'hashRouteCount')
    if (hashRouteCount !== undefined && hashRouteCount > 0) {
      const truncated = metaBoolean(meta, 'domXssTruncated') ? ' (budget reached)' : ''
      rows.push(`| DOM XSS probe (hash routes) | ${hashRouteCount}${truncated} |`)
    }
  } else {
    const targetUrl = metaString(meta, 'targetUrl')
    if (targetUrl) rows.push(`| Target URL | ${code(targetUrl)} |`)
    const openapiSource = metaString(meta, 'openapiSource')
    if (openapiSource) rows.push(`| OpenAPI source | ${text(openapiSource)} |`)
    const maxScanMinutes = metaNumber(meta, 'maxScanMinutes')
    if (maxScanMinutes !== undefined) rows.push(`| Max scan minutes | ${maxScanMinutes} |`)
  }
  const reachedUrlCount = metaNumber(meta, 'reachedUrlCount')
  if (reachedUrlCount !== undefined) rows.push(`| Reached URLs | ${reachedUrlCount} |`)
  const authFailureCount = metaNumber(meta, 'authFailureCount')
  if (authFailureCount !== undefined) rows.push(`| Auth failures (401/403) | ${authFailureCount} |`)
  const alertCounts = metaRecord(meta, 'alertCounts')
  if (alertCounts) {
    const low = metaNumber(alertCounts, 'low')
    const info = metaNumber(alertCounts, 'info')
    if (low !== undefined || info !== undefined)
      rows.push(`| Low / Info (not detailed) | ${low ?? 0} / ${info ?? 0} |`)
  }
  const excludeRegexes = metaStringArray(meta, 'excludeRegexes')
  if (excludeRegexes) rows.push(`| Exclude regexes | ${excludeRegexes.length} |`)
  return rows
}
