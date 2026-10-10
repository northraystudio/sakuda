import type { BrowserStorageName } from '../schemas/browserStorage'
import type { TargetMethod } from '../utils/nucleiPaths'

export type Engine = 'nuclei' | 'zap-api' | 'zap-fe' | 'dalfox'
export const RISK_TAGS = ['dos', 'fuzz', 'intrusive'] as const
export type RiskTag = (typeof RISK_TAGS)[number]
export type Severity = 'critical' | 'high' | 'medium'
export type SeverityLevel = Severity | 'low' | 'info'
export interface SeverityCounts {
  critical: number
  high: number
  medium: number
  low: number
  info: number
}
export type ScanStatus = 'queued' | 'running' | 'done' | 'failed'
export type EngineRunStatus = 'running' | 'done' | 'failed' | 'skipped'
export interface SitePublic {
  id: string
  name: string
  frontBaseUrl: string
  apiBaseUrl: string | null
  nucleiPaths: string
  openapiUrl: string | null
  openapiJson: string | null
  zapFeSeedPath: string
  discoverySeedPaths: string
  /** Crawl range as path prefixes (one per line); '' = whole origin. */
  crawlScopePaths: string
  excludePaths: string
  nucleiRateLimit: number
  /** null → SAKUDA_NUCLEI_MAX_MINUTES (see server/domain/nucleiLimits). */
  nucleiMaxMinutes: number | null
  /** null → SAKUDA_NUCLEI_CONCURRENCY (see server/domain/nucleiLimits). */
  nucleiConcurrency: number | null
  zapApiMaxMinutes: number
  zapFeSpiderMaxMinutes: number
  nonLocalConfirmed: boolean
  /** Opt-in for active injection checks; effective only with ownership established. */
  allowMutatingRequests: boolean
  /** nuclei risk-template groups the user opted this site into; effective only
   * with active checks on (see server/domain/activeScan). */
  nucleiEnabledRiskTags: RiskTag[]
  headerNames: string[]
  /** kind + name of each injected browser-storage item; values are write-only. */
  browserStorageNames: BrowserStorageName[]
  /** Value-free request-body shapes of approved non-GET targets, keyed by
   * `targetLineKey` (see #72). Consumed by the generated OpenAPI (#73). */
  requestShapes: Record<string, RequestShape>
  requiresConfirmation: boolean
  createdAt: string
  updatedAt: string
}
/** One approved non-GET target's saved request shape: the observed media type
 * (media type only, not a secret) plus the value-free body shape. */
export interface RequestShape {
  contentType: string | null
  bodyShape: BodyShape
}
export type SiteSnapshot = Omit<SitePublic, 'openapiJson' | 'createdAt' | 'updatedAt'> & {
  hasOpenapiJson: boolean
}
export interface ScanSummary {
  id: string
  siteId: string
  status: ScanStatus
  engines: Engine[]
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  counts: SeverityCounts
}
export interface SiteListItem extends SitePublic {
  lastScan: ScanSummary | null
}
/** One component of an engine's wall-clock budget, in minutes. */
export interface EngineTimeBudgetPart {
  label: string
  minutes: number
}
/** The wall-clock budget an engine run is given: the parts it is made of
 * and their sum, which is the hard timeout the run is killed at. Computed
 * in one place (server/domain/engineTimeBudget) and recorded by the engine
 * into `meta.timeBudget` at run time. */
export interface EngineTimeBudget {
  parts: EngineTimeBudgetPart[]
  totalMinutes: number
}
/** The budget as the API reports it: `estimated` is false when the engine
 * recorded it at run time, true when it was reconstructed from the site
 * snapshot and the *current* env for a run older than that recording. */
export interface EngineRunLimits extends EngineTimeBudget {
  estimated: boolean
}
export interface EngineRunView {
  id: string
  engine: Engine
  status: EngineRunStatus
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  signal: string | null
  counts: SeverityCounts
  meta: Record<string, unknown>
  warnings: string[]
  error: string | null
  limits: EngineRunLimits
}
export interface FindingView {
  id: string
  engine: Engine
  ruleId: string
  name: string
  severity: Severity
  url: string
  method: string | null
  param: string | null
  evidence: string | null
  description: string | null
  solution: string | null
  reference: string | null
  fingerprint: string
  isNew: boolean
}
export interface ScanDiff {
  previousScanId: string
  newCount: number
  persistingCount: number
  resolved: FindingView[]
}
export interface ScanDetail extends ScanSummary {
  siteName: string
  siteSnapshot: SiteSnapshot
  engineRuns: EngineRunView[]
  findings: FindingView[]
  diff: ScanDiff | null
  /** Server clock at response time; the client derives elapsed time from
   * this rather than its own clock, so a skewed browser clock cannot show a
   * negative or inflated duration. */
  now: string
}
export interface HistoryPoint {
  scanId: string
  createdAt: string
  finishedAt: string | null
  status: ScanStatus
  counts: SeverityCounts
  engines: Partial<Record<Engine, SeverityCounts>>
  diff: { new: number; persisting: number; resolved: number } | null
}
/** The value-free shape of one JSON node: its type, plus (for containers)
 * child field names / element shapes. Never a captured value — only names and
 * type labels. A container nested past the depth cap keeps `truncated: true`
 * and drops its children. */
export interface JsonFieldShape {
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
  /** object: field name → shape (absent when `truncated`). */
  fields?: Record<string, JsonFieldShape>
  /** array: the distinct element shapes (absent when `truncated`). */
  items?: JsonFieldShape[]
  /** A container deeper than the shape's depth cap: only its type is kept. */
  truncated?: true
}
/** The value-free shape of a captured request body (see `bodyShape.ts`).
 * `json` keeps key names + JSON types; `form` keeps field names; everything
 * else (multipart, text, malformed) is `other`. No captured value is ever
 * carried — field names are API contract, values are not stored. */
export type BodyShape =
  { kind: 'json'; root: JsonFieldShape } | { kind: 'form'; fields: string[] } | { kind: 'other' }
/** One URL found by a discovery crawl, after normalization (same origin,
 * fragment stripped, assets/noise/excluded paths removed). */
export interface DiscoveredUrl {
  url: string
  method: string
  statusCode: number
  /** Which crawler first reached it: ZAP's traditional spider, ZAP's Ajax
   * spider, ZAP's Client Spider (browser-driven form submission, active checks
   * only), katana's static JS-bundle crawl, or another ZAP history type. */
  source: 'spider' | 'ajax' | 'client' | 'katana' | 'other'
  /** Request Content-Type observed for a non-GET body, if any. */
  contentType?: string
  /** Value-free shape of the request body, if the crawl captured one. */
  bodyShape?: BodyShape
}
export type DiscoveryStatus = ScanStatus
export interface DiscoverySummary {
  id: string
  siteId: string
  status: DiscoveryStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  urlCount: number
}
export interface DiscoveryDetail extends DiscoverySummary {
  urls: DiscoveredUrl[]
  meta: Record<string, unknown>
  warnings: string[]
}
export interface AddTargetsResult {
  site: SitePublic
  added: string[]
  skipped: string[]
}
/** Result of `DELETE /api/sites/:id/targets`: the site after the removal and
 * whether a saved line actually matched (false = idempotent no-op). */
export interface RemoveTargetResult {
  site: SitePublic
  removed: boolean
}

/** One saved target line as the engines see it: method, base and the
 * relative path (query included, host never) — the same identity as
 * `targetLineKey`. Never carries a body shape or a header. */
export interface TargetRef {
  method: TargetMethod
  base: 'front' | 'api'
  path: string
}
/** What one engine does with the saved list on the next scan. */
export interface EngineTargets {
  /** False when the engine cannot run with the site as configured (dalfox
   * without active checks, ZAP API without any OpenAPI source). */
  available: boolean
  /** Saved lines the engine will request. */
  targets: TargetRef[]
  /** Saved lines the engine leaves alone: wrong base, a hash route it cannot
   * reach, or a mutating method on a passive run. */
  skipped: TargetRef[]
}
/** `GET /api/sites/:id/targets`: the saved list every engine shares, and the
 * per-engine view of it — computed by `summarizeTargets`, never edited here. */
export interface TargetSummary {
  /** False when no line is saved (nuclei then scans the base URL roots). */
  configured: boolean
  /** The value of `isActiveScanEnabled` the engines will read. */
  activeChecks: boolean
  /** Saved lines after Exclude paths, in saved order. */
  common: TargetRef[]
  /** GET lines dropped by Exclude paths (count only). */
  excludedCount: number
  engines: Record<Engine, EngineTargets>
  /** Where ZAP API's operations come from on the next scan. */
  zapApiSource: 'openapi' | 'generated' | 'openapi+generated' | 'none'
}
/** One running or queued job, across all sites. Returned by `GET /api/jobs`
 * in the job loop's claim order (running first, then queued scans oldest-first,
 * then queued discoveries oldest-first) — display order = execution order. */
export interface JobView {
  kind: 'scan' | 'discovery'
  status: 'running' | 'queued'
  id: string
  siteId: string
  siteName: string
  createdAt: string
  startedAt: string | null
  /** Only for scans. */
  engines?: Engine[]
}
export interface ApiErrorData {
  code?: string
  issues?: string[]
}
