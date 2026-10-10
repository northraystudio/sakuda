import { z } from 'zod'
import { RISK_TAGS } from '../types/api'
import { BrowserStoragePatchesSchema, BrowserStorageSchema } from './browserStorage'
import { HeaderPatchesSchema, HeadersSchema } from './headers'
import { siteRequiresConfirmation } from '../utils/localHost'
import { parseNucleiPathLines } from '../utils/nucleiPaths'
import { parseCrawlScopeLines } from '../utils/crawlScope'
import { parseSeedPathLines } from '../utils/seedPaths'

/** Upper bound of the saved target list; `addSiteTargets` enforces the same
 * limit so a discovery save can never leave the site un-editable through
 * the form (which validates against this schema). */
export const NUCLEI_PATHS_MAX_CHARS = 20_000

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const HttpUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .transform((u) => u.replace(/\/+$/, ''))
const OptionalHttpUrl = z.preprocess(emptyToNull, HttpUrl.nullable()).default(null)

const SiteFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  frontBaseUrl: HttpUrl,
  apiBaseUrl: OptionalHttpUrl,
  nucleiPaths: z.string().max(NUCLEI_PATHS_MAX_CHARS).default(''),
  openapiUrl: OptionalHttpUrl,
  openapiJson: z.preprocess(emptyToNull, z.string().max(5_000_000).nullable()).default(null),
  zapFeSeedPath: z
    .string()
    .regex(/^\/\S*$/, 'must start with "/"')
    .default('/'),
  /** Discovery crawl seeds, one path per line; empty → `zapFeSeedPath`. */
  discoverySeedPaths: z.string().max(5_000).default(''),
  /** Path prefixes the crawls (discovery, zap-fe) may follow, one per line;
   * empty → the whole origin. Seeds are start points, this is the range —
   * see `server/domain/crawlScope`. */
  crawlScopePaths: z.string().max(5_000).default(''),
  excludePaths: z.string().max(5_000).default(''),
  nucleiRateLimit: z.number().int().min(1).max(1000).default(50),
  /** Per-site overrides of SAKUDA_NUCLEI_MAX_MINUTES / SAKUDA_NUCLEI_CONCURRENCY;
   * null → the env value (see server/domain/nucleiLimits). */
  nucleiMaxMinutes: z.number().int().min(1).max(600).nullable().default(null),
  nucleiConcurrency: z.number().int().min(1).max(100).nullable().default(null),
  zapApiMaxMinutes: z.number().int().min(1).max(600).default(45),
  zapFeSpiderMaxMinutes: z.number().int().min(1).max(120).default(5),
  nonLocalConfirmed: z.boolean().default(false),
  /** Site-level opt-in for active injection checks (nuclei DAST). Off by
   * default: a scan then sends passive + signature requests only. See
   * `server/domain/activeScan.ts` for the effective decision. */
  allowMutatingRequests: z.boolean().default(false),
  /** nuclei risk-template groups to un-exclude, effective only under
   * allowMutatingRequests (see server/domain/activeScan). */
  nucleiEnabledRiskTags: z.array(z.enum(RISK_TAGS)).default([]),
  headers: HeadersSchema.optional(),
  /** Injected into ZAP's browser before the Ajax spider runs (SPA login state). */
  browserStorage: BrowserStorageSchema.optional(),
})

type SiteFields = z.infer<typeof SiteFieldsSchema>

/** Cross-field rules shared by create and update — they read neither header
 * nor browser-storage values, so the create/patch shapes can share them
 * verbatim (both secret fields are omitted from the input type). */
function refineSiteFields(v: Omit<SiteFields, 'headers' | 'browserStorage'>, ctx: z.RefinementCtx) {
  const parsed = parseNucleiPathLines(v.nucleiPaths)
  for (const e of parsed.errors) ctx.addIssue({ code: 'custom', path: ['nucleiPaths'], message: e })
  for (const e of parseSeedPathLines(v.discoverySeedPaths).errors)
    ctx.addIssue({ code: 'custom', path: ['discoverySeedPaths'], message: e })
  for (const e of parseCrawlScopeLines(v.crawlScopePaths).errors)
    ctx.addIssue({ code: 'custom', path: ['crawlScopePaths'], message: e })
  if (!v.apiBaseUrl && parsed.lines.some((l) => l.base === 'api')) {
    ctx.addIssue({
      code: 'custom',
      path: ['apiBaseUrl'],
      message: 'apiBaseUrl is required because nucleiPaths contains "api:" lines',
    })
  }
  if (v.openapiUrl && v.openapiJson) {
    ctx.addIssue({
      code: 'custom',
      path: ['openapiJson'],
      message: 'set either openapiUrl or openapiJson, not both',
    })
  }
  if (v.openapiJson) {
    // boundary validation: a parse failure becomes a validation issue, not an exception
    try {
      const j: unknown = JSON.parse(v.openapiJson)
      if (typeof j !== 'object' || j === null) throw new Error('not an object')
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['openapiJson'],
        message: 'openapiJson must be a JSON object',
      })
    }
  }
  if (
    siteRequiresConfirmation(v.frontBaseUrl, v.apiBaseUrl, v.openapiUrl) &&
    !v.nonLocalConfirmed
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['nonLocalConfirmed'],
      message:
        'target host is not local: confirm you are authorized to scan it (nonLocalConfirmed)',
    })
  }
}

/** `POST /api/sites`: every header row carries its value. */
export const SiteInputSchema = SiteFieldsSchema.superRefine(refineSiteFields)

/** `PUT /api/sites/:id`: a header row may omit `value` to keep the stored
 * one (see `siteService.updateSite`). A `SiteInput` is also a valid update,
 * so clients that always send values keep working. */
export const SiteUpdateSchema = SiteFieldsSchema.extend({
  headers: HeaderPatchesSchema.optional(),
  browserStorage: BrowserStoragePatchesSchema.optional(),
}).superRefine(refineSiteFields)

export type SiteInput = z.infer<typeof SiteInputSchema>
export type SiteUpdateInput = z.infer<typeof SiteUpdateSchema>
