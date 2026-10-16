import { desc, eq } from 'drizzle-orm'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '../db/client'
import { discoveries, scans, sites } from '../db/schema'
import type { SiteCipher } from '../domain/headerCipher'
import { resolveSecretExpiries, type SecretExpiryEntry } from '../domain/secretExpiry'
import { toSitePublic } from '../domain/siteView'
import { parseNucleiPathLines, targetLineKey } from '#shared/utils/nucleiPaths'
import { mergeTargetLines, removeTargetLine } from '#shared/utils/targetLines'
import { secretKey } from '#shared/utils/secretExpiry'
import type { Logger } from '../lib/logger'
import { ServiceError } from './errors'
import { latestScanSummary } from './scanService'
import type { BrowserStorageItem, BrowserStoragePatch } from '#shared/schemas/browserStorage'
import type { Header, HeaderPatch } from '#shared/schemas/headers'
import type { TargetShape } from '#shared/schemas/targets'
import { NUCLEI_PATHS_MAX_CHARS, type SiteInput, type SiteUpdateInput } from '#shared/schemas/site'
import type {
  AddTargetsResult,
  RemoveTargetResult,
  RequestShape,
  SiteListItem,
  SitePublic,
  SiteSecrets,
} from '#shared/types/api'

export { toSitePublic, toSiteSnapshot } from '../domain/siteView'

export interface SiteServiceDeps {
  db: Db
  cipher: SiteCipher
  now: () => Date
  id: () => string
}

/** A site with its decrypted secrets — only ever built inside the job
 * runners, never returned by the API. */
export interface SiteWithHeaders extends SitePublic {
  headers: Header[]
  browserStorage: BrowserStorageItem[]
}

function sealHeaders(deps: SiteServiceDeps, siteId: string, headers: Header[]) {
  if (headers.length === 0) return { headersEnc: null, headerNames: [] as string[] }
  return {
    headersEnc: deps.cipher.headers.seal(headers, siteId),
    headerNames: headers.map((h) => h.name),
  }
}

function sealBrowserStorage(deps: SiteServiceDeps, siteId: string, items: BrowserStorageItem[]) {
  if (items.length === 0) return { browserStorageEnc: null, browserStorageNames: [] }
  return {
    browserStorageEnc: deps.cipher.browserStorage.seal(items, siteId),
    browserStorageNames: items.map((i) => ({ kind: i.kind, name: i.name })),
  }
}

function getSiteOrThrow(db: Db, id: string): SitePublic {
  const s = getSite(db, id)
  if (!s) throw new ServiceError(404, 'SITE_NOT_FOUND', `site ${id} not found`)
  return s
}

export function getSite(db: Db, id: string): SitePublic | null {
  const row = db.select().from(sites).where(eq(sites.id, id)).get()
  return row ? toSitePublic(row) : null
}

export function createSite(deps: SiteServiceDeps, input: SiteInput): SitePublic {
  const id = deps.id()
  const now = deps.now().toISOString()
  const { headers = [], browserStorage = [], ...fields } = input
  deps.db
    .insert(sites)
    .values({
      id,
      ...fields,
      ...sealHeaders(deps, id, headers),
      ...sealBrowserStorage(deps, id, browserStorage),
      secretExpiries: resolveSecretExpiries(
        [...headers, ...browserStorage].map((i) => ({
          key: secretKey(i),
          value: i.value,
          kept: false,
        })),
        {},
      ),
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return getSiteOrThrow(deps.db, id)
}

/**
 * Resolves the header rows of an update against the stored set: a row with
 * a value is the new value, a row without one keeps the stored value for
 * that name (exact, case-sensitive match), and stored names absent from the
 * list are dropped. The header cipher is the only place values ever exist
 * in the clear, so this is the one place the merge can happen — the UI
 * never sees stored values and cannot merge on its own.
 */
function mergeHeaderPatches(stored: Header[], patches: HeaderPatch[]): Header[] {
  const storedByName = new Map(stored.map((h) => [h.name, h.value]))
  const unknown: string[] = []
  const merged: Header[] = []
  for (const patch of patches) {
    const value = patch.value ?? storedByName.get(patch.name)
    if (value === undefined) unknown.push(patch.name)
    else merged.push({ name: patch.name, value })
  }
  if (unknown.length > 0)
    throw new ServiceError(
      422,
      'VALIDATION',
      `header value is required for ${unknown.map((n) => `"${n}"`).join(', ')} — no stored value exists for that name (names match exactly, case-sensitive)`,
      { headers: unknown },
    )
  return merged
}

/**
 * Browser-storage counterpart of `mergeHeaderPatches`: resolves the rows of an
 * update against the stored set on the (kind, name) pair (exact, case-sensitive).
 * A row with a value is the new value, a row without one keeps the stored value
 * for that pair, and stored pairs absent from the list are dropped. Values only
 * ever exist in the clear inside the browser-storage cipher, so this is the one
 * place the merge can happen — the UI never sees stored values.
 */
function mergeBrowserStoragePatches(
  stored: BrowserStorageItem[],
  patches: BrowserStoragePatch[],
): BrowserStorageItem[] {
  const key = (i: { kind: string; name: string }) => `${i.kind}\n${i.name}`
  const storedByKey = new Map(stored.map((i) => [key(i), i.value]))
  const unknown: string[] = []
  const merged: BrowserStorageItem[] = []
  for (const patch of patches) {
    const value = patch.value ?? storedByKey.get(key(patch))
    if (value === undefined) unknown.push(`${patch.kind}:${patch.name}`)
    else merged.push({ kind: patch.kind, name: patch.name, value })
  }
  if (unknown.length > 0)
    throw new ServiceError(
      422,
      'VALIDATION',
      `browser storage value is required for ${unknown.map((n) => `"${n}"`).join(', ')} — no stored value exists for that item (kind + name match exactly, case-sensitive)`,
      { browserStorage: unknown },
    )
  return merged
}

/** Patch rows and merged items line up 1:1 (the merge throws otherwise). */
function expiryEntries(
  patches: (HeaderPatch | BrowserStoragePatch)[],
  merged: (Header | BrowserStorageItem)[],
): SecretExpiryEntry[] {
  return merged.map((item, i) => ({
    key: secretKey(item),
    value: item.value,
    expiresAt: patches[i]?.expiresAt,
    kept: patches[i]?.value === undefined,
  }))
}

/** Expiries of the half (headers or storage) an update left alone. */
function keepExpiries(previous: Record<string, string>, headers: boolean): Record<string, string> {
  return Object.fromEntries(
    Object.entries(previous).filter(([k]) => k.startsWith('header:') === headers),
  )
}

export function updateSite(deps: SiteServiceDeps, id: string, input: SiteUpdateInput): SitePublic {
  const existing = deps.db.select().from(sites).where(eq(sites.id, id)).get()
  if (!existing) throw new ServiceError(404, 'SITE_NOT_FOUND', `site ${id} not found`)
  // Secrets are write-only: omitting the field keeps the stored set, [] clears it.
  const { headers, browserStorage, ...fields } = input
  const previousExpiries = existing.secretExpiries
  const mergedHeaders =
    headers === undefined
      ? undefined
      : mergeHeaderPatches(
          existing.headersEnc ? deps.cipher.headers.open(existing.headersEnc, id) : [],
          headers,
        )
  const mergedStorage =
    browserStorage === undefined
      ? undefined
      : mergeBrowserStoragePatches(
          existing.browserStorageEnc
            ? deps.cipher.browserStorage.open(existing.browserStorageEnc, id)
            : [],
          browserStorage,
        )
  const sealed = mergedHeaders === undefined ? {} : sealHeaders(deps, id, mergedHeaders)
  const sealedStorage =
    mergedStorage === undefined ? {} : sealBrowserStorage(deps, id, mergedStorage)
  const secretExpiries = {
    ...(headers === undefined || mergedHeaders === undefined
      ? keepExpiries(previousExpiries, true)
      : resolveSecretExpiries(expiryEntries(headers, mergedHeaders), previousExpiries)),
    ...(browserStorage === undefined || mergedStorage === undefined
      ? keepExpiries(previousExpiries, false)
      : resolveSecretExpiries(expiryEntries(browserStorage, mergedStorage), previousExpiries)),
  }
  // Saved shapes belong to saved target lines: dropping a line in Edit (where
  // nucleiPaths is rewritten wholesale) must drop its shape too.
  const requestShapes = pruneRequestShapes(existing.requestShapes, fields.nucleiPaths)
  deps.db
    .update(sites)
    .set({
      ...fields,
      ...sealed,
      ...sealedStorage,
      secretExpiries,
      requestShapes,
      updatedAt: deps.now().toISOString(),
    })
    .where(eq(sites.id, id))
    .run()
  return getSiteOrThrow(deps.db, id)
}

/**
 * Appends target lines (`/path` or `api:/path`) to the site's saved list —
 * the one place discovery results and hand-written paths end up. Append-only
 * and deduped, so re-saving the same discovery is a no-op rather than a
 * duplicate. Invalid lines reject the whole request (422) with every bad
 * line named, and nothing is written.
 */
export function addSiteTargets(
  deps: SiteServiceDeps,
  id: string,
  lines: string[],
  shapes: TargetShape[] = [],
): AddTargetsResult {
  const existing = deps.db.select().from(sites).where(eq(sites.id, id)).get()
  if (!existing) throw new ServiceError(404, 'SITE_NOT_FOUND', `site ${id} not found`)
  const merged = mergeTargetLines(existing.nucleiPaths, lines)
  if (merged.invalid.length > 0)
    throw new ServiceError(
      422,
      'VALIDATION',
      `invalid target line(s): ${merged.invalid.join(', ')} — each line must be "[METHOD] [api:]/path": a path starting with "/", optionally prefixed with an HTTP method (default GET) and/or "api:"`,
      { invalid: merged.invalid },
    )
  const addedApiLines = merged.added.filter((l) =>
    parseNucleiPathLines(l).lines.some((p) => p.base === 'api'),
  )
  if (!existing.apiBaseUrl && addedApiLines.length > 0)
    throw new ServiceError(
      422,
      'VALIDATION',
      'api: lines require apiBaseUrl to be set on the site',
      { invalid: addedApiLines },
    )
  if (merged.text.length > NUCLEI_PATHS_MAX_CHARS)
    throw new ServiceError(
      422,
      'VALIDATION',
      `saving ${merged.added.length} line(s) would make the target list ${merged.text.length} characters, over the ${NUCLEI_PATHS_MAX_CHARS} limit — select fewer URLs or remove saved paths in Edit`,
      { limit: NUCLEI_PATHS_MAX_CHARS, wouldBe: merged.text.length },
    )
  // Store a value-free body shape for each approved non-GET line, keyed by
  // targetLineKey. Only shapes whose line is actually in the saved set are kept
  // (the approval gate: a shape enters the site only with its approved line),
  // and re-approving the same line overwrites its shape.
  const savedKeys = new Set(parseNucleiPathLines(merged.text).lines.map(targetLineKey))
  const nextShapes: Record<string, RequestShape> = { ...existing.requestShapes }
  let shapesChanged = false
  for (const s of shapes) {
    const only = parseNucleiPathLines(s.line).lines[0]
    if (!only || only.method === 'GET') continue
    const key = targetLineKey(only)
    if (!savedKeys.has(key)) continue
    nextShapes[key] = { contentType: s.contentType, bodyShape: s.bodyShape }
    shapesChanged = true
  }
  if (merged.added.length > 0 || shapesChanged)
    deps.db
      .update(sites)
      .set({
        nucleiPaths: merged.text,
        ...(shapesChanged ? { requestShapes: nextShapes } : {}),
        updatedAt: deps.now().toISOString(),
      })
      .where(eq(sites.id, id))
      .run()
  return { site: getSiteOrThrow(deps.db, id), added: merged.added, skipped: merged.skipped }
}

/** Keeps only the shapes whose target line is still in `nucleiPaths` — a
 * shape never outlives the line it was approved with. */
function pruneRequestShapes(
  shapes: Record<string, RequestShape>,
  nucleiPaths: string,
): Record<string, RequestShape> {
  const savedKeys = new Set(parseNucleiPathLines(nucleiPaths).lines.map(targetLineKey))
  const kept: Record<string, RequestShape> = {}
  for (const [key, shape] of Object.entries(shapes)) if (savedKeys.has(key)) kept[key] = shape
  return kept
}

/**
 * Removes one saved target line — the counterpart of `addSiteTargets`, so
 * the discovery review can un-save a line without a wholesale Edit. Identity
 * is method + base + path; the rest of the text (comments, ordering) stays
 * verbatim, and the line's request shape goes with it. Idempotent: a line
 * that is not saved changes nothing and reports `removed: false`.
 */
export function removeSiteTarget(
  deps: SiteServiceDeps,
  id: string,
  line: string,
): RemoveTargetResult {
  const existing = deps.db.select().from(sites).where(eq(sites.id, id)).get()
  if (!existing) throw new ServiceError(404, 'SITE_NOT_FOUND', `site ${id} not found`)
  const result = removeTargetLine(existing.nucleiPaths, line)
  if (result.invalid)
    throw new ServiceError(
      422,
      'VALIDATION',
      `invalid target line: ${line} — must be "[METHOD] [api:]/path": a path starting with "/", optionally prefixed with an HTTP method (default GET) and/or "api:"`,
      { invalid: [line] },
    )
  if (result.removed)
    deps.db
      .update(sites)
      .set({
        nucleiPaths: result.text,
        requestShapes: pruneRequestShapes(existing.requestShapes, result.text),
        updatedAt: deps.now().toISOString(),
      })
      .where(eq(sites.id, id))
      .run()
  return { site: getSiteOrThrow(deps.db, id), removed: result.removed }
}

/**
 * Deletes the site row (cascading to its scans/discoveries/engine_runs/findings
 * — see the schema's ON DELETE CASCADE), then best-effort removes each
 * deleted job's on-disk artifacts (`<scansDir>/<scanId>`: nuclei's JSONL,
 * ZAP's report/logs; `<discoveriesDir>/<discoveryId>`: the site-tree dump). Retention model: scan artifacts live as long as the site
 * does, and are removed when the site is deleted — there is no separate
 * per-scan retention policy in the MVP.
 *
 * Disk cleanup is deliberately non-fatal: the DB delete is the source of
 * truth for "the site is gone", and a stray directory the OS couldn't remove
 * (permissions, a still-open file handle) must not turn a successful delete
 * into an error the caller has to handle specially.
 */
export async function deleteSite(
  db: Db,
  id: string,
  opts?: { scansDir: string; discoveriesDir: string; logger: Logger },
): Promise<boolean> {
  const artifactDirs: string[] = opts
    ? [
        ...db
          .select({ id: scans.id })
          .from(scans)
          .where(eq(scans.siteId, id))
          .all()
          .map((r) => join(opts.scansDir, r.id)),
        ...db
          .select({ id: discoveries.id })
          .from(discoveries)
          .where(eq(discoveries.siteId, id))
          .all()
          .map((r) => join(opts.discoveriesDir, r.id)),
      ]
    : []
  const deleted = db.delete(sites).where(eq(sites.id, id)).run().changes > 0
  if (deleted && opts) {
    for (const dir of artifactDirs) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch (e) {
        opts.logger.warn({ siteId: id, dir, err: e }, 'failed to remove job artifact directory')
      }
    }
  }
  return deleted
}

export function listSites(db: Db): SiteListItem[] {
  return db
    .select()
    .from(sites)
    .orderBy(desc(sites.updatedAt))
    .all()
    .map((r) => ({ ...toSitePublic(r), lastScan: latestScanSummary(db, r.id) }))
}

/** Decrypted values for the edit form's show/hide toggle (#17). The route
 * guards it to loopback callers; this function only reads. */
export function getSiteSecrets(deps: SiteServiceDeps, id: string): SiteSecrets | null {
  const site = loadSiteWithHeaders(deps, id)
  return site ? { headers: site.headers, browserStorage: site.browserStorage } : null
}

export function loadSiteWithHeaders(deps: SiteServiceDeps, id: string): SiteWithHeaders | null {
  const row = deps.db.select().from(sites).where(eq(sites.id, id)).get()
  if (!row) return null
  return {
    ...toSitePublic(row),
    headers: row.headersEnc ? deps.cipher.headers.open(row.headersEnc, id) : [],
    browserStorage: row.browserStorageEnc
      ? deps.cipher.browserStorage.open(row.browserStorageEnc, id)
      : [],
  }
}
