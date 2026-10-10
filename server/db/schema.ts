import { blob, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { BrowserStorageName } from '#shared/schemas/browserStorage'
import type {
  DiscoveredUrl,
  Engine,
  RequestShape,
  RiskTag,
  SeverityCounts,
  SiteSnapshot,
} from '#shared/types/api'

export const sites = sqliteTable('sites', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  frontBaseUrl: text('front_base_url').notNull(),
  apiBaseUrl: text('api_base_url'),
  nucleiPaths: text('nuclei_paths').notNull(),
  openapiUrl: text('openapi_url'),
  openapiJson: text('openapi_json'),
  zapFeSeedPath: text('zap_fe_seed_path').notNull(),
  discoverySeedPaths: text('discovery_seed_paths').notNull().default(''),
  crawlScopePaths: text('crawl_scope_paths').notNull().default(''),
  excludePaths: text('exclude_paths').notNull(),
  nucleiRateLimit: integer('nuclei_rate_limit').notNull(),
  nucleiMaxMinutes: integer('nuclei_max_minutes'),
  nucleiConcurrency: integer('nuclei_concurrency'),
  zapApiMaxMinutes: integer('zap_api_max_minutes').notNull(),
  zapFeSpiderMaxMinutes: integer('zap_fe_spider_max_minutes').notNull(),
  nonLocalConfirmed: integer('non_local_confirmed', { mode: 'boolean' }).notNull(),
  allowMutatingRequests: integer('allow_mutating_requests', { mode: 'boolean' })
    .notNull()
    .default(false),
  nucleiEnabledRiskTags: text('nuclei_enabled_risk_tags', { mode: 'json' })
    .$type<RiskTag[]>()
    .notNull()
    .default([]),
  headersEnc: blob('headers_enc', { mode: 'buffer' }),
  headerNames: text('header_names', { mode: 'json' }).$type<string[]>().notNull(),
  browserStorageEnc: blob('browser_storage_enc', { mode: 'buffer' }),
  browserStorageNames: text('browser_storage_names', { mode: 'json' })
    .$type<BrowserStorageName[]>()
    .notNull()
    .default([]),
  requestShapes: text('request_shapes', { mode: 'json' })
    .$type<Record<string, RequestShape>>()
    .notNull()
    .default({}),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const scans = sqliteTable(
  'scans',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull(),
    engines: text('engines', { mode: 'json' }).$type<Engine[]>().notNull(),
    siteSnapshot: text('site_snapshot', { mode: 'json' }).$type<SiteSnapshot>().notNull(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('scans_site_created_idx').on(t.siteId, t.createdAt),
    index('scans_status_idx').on(t.status),
  ],
)
export const engineRuns = sqliteTable(
  'engine_runs',
  {
    id: text('id').primaryKey(),
    scanId: text('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    engine: text('engine', { enum: ['nuclei', 'zap-api', 'zap-fe', 'dalfox'] }).notNull(),
    status: text('status', { enum: ['running', 'done', 'failed', 'skipped'] }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    exitCode: integer('exit_code'),
    signal: text('signal'),
    counts: text('counts', { mode: 'json' }).$type<SeverityCounts>().notNull(),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull(),
    error: text('error'),
  },
  (t) => [index('engine_runs_scan_idx').on(t.scanId)],
)
export const findings = sqliteTable(
  'findings',
  {
    id: text('id').primaryKey(),
    scanId: text('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    engineRunId: text('engine_run_id')
      .notNull()
      .references(() => engineRuns.id, { onDelete: 'cascade' }),
    engine: text('engine', { enum: ['nuclei', 'zap-api', 'zap-fe', 'dalfox'] }).notNull(),
    ruleId: text('rule_id').notNull(),
    name: text('name').notNull(),
    severity: text('severity', { enum: ['critical', 'high', 'medium'] }).notNull(),
    url: text('url').notNull(),
    method: text('method'),
    param: text('param'),
    evidence: text('evidence'),
    description: text('description'),
    solution: text('solution'),
    reference: text('reference'),
    fingerprint: text('fingerprint').notNull(),
    raw: text('raw', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('findings_scan_idx').on(t.scanId),
    index('findings_scan_fp_idx').on(t.scanId, t.fingerprint),
  ],
)
/** A crawl-only job: finds URLs for the user to approve as saved targets.
 * Deliberately separate from `scans` — it produces no findings, has no
 * diff/history semantics, and must never show up in the scan list. */
export const discoveries = sqliteTable(
  'discoveries',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull(),
    urls: text('urls', { mode: 'json' }).$type<DiscoveredUrl[]>().notNull(),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('discoveries_site_created_idx').on(t.siteId, t.createdAt),
    index('discoveries_status_idx').on(t.status),
  ],
)
export type SiteRow = typeof sites.$inferSelect
export type DiscoveryRow = typeof discoveries.$inferSelect
export type ScanRow = typeof scans.$inferSelect
export type EngineRunRow = typeof engineRuns.$inferSelect
export type FindingRow = typeof findings.$inferSelect
