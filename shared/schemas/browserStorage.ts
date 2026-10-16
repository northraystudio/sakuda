import { z } from 'zod'

/** Where a value is injected into ZAP's browser before the Ajax spider
 * crawls: web storage (what SPAs use for a login token) or a cookie. */
export const BROWSER_STORAGE_KINDS = ['localStorage', 'sessionStorage', 'cookie'] as const
export type BrowserStorageKind = (typeof BROWSER_STORAGE_KINDS)[number]

const Kind = z.enum(BROWSER_STORAGE_KINDS)
const Name = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]*$/, 'name must not contain CR/LF')
const Value = z
  .string()
  .min(1)
  .max(10_000)
  .regex(/^[^\r\n]*$/, 'value must not contain CR/LF')

/** Cookie syntax: the name must be a token and the value must not carry a
 * separator, or `document.cookie = name=value` would set something else. The
 * value is optional so a patch row (value omitted = keep the stored one) can
 * reuse the same check — the value rule only applies when a value is present. */
function refineCookieSyntax(
  v: { kind: BrowserStorageKind; name: string; value?: string },
  ctx: z.RefinementCtx,
) {
  if (v.kind === 'cookie' && !/^[^\s;=,]+$/.test(v.name))
    ctx.addIssue({
      code: 'custom',
      path: ['name'],
      message: 'cookie name must not contain whitespace, ";", "=" or ","',
    })
  if (v.kind === 'cookie' && v.value !== undefined && /[;]/.test(v.value))
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'cookie value must not contain ";"',
    })
}

export const BrowserStorageItemSchema = z
  .object({ kind: Kind, name: Name, value: Value })
  .superRefine(refineCookieSyntax)

/** One row of a site update: a missing `value` means "keep the stored value
 * for this (kind, name)" — the merge itself lives in `siteService.updateSite`. */
export const BrowserStoragePatchSchema = z
  .object({
    kind: Kind,
    name: Name,
    value: Value.optional(),
    /** Known expiry of a new value (a captured cookie's `expires`, #17). */
    expiresAt: z.iso.datetime().optional(),
  })
  .superRefine(refineCookieSyntax)
  .refine((i) => i.expiresAt === undefined || i.value !== undefined, {
    path: ['expiresAt'],
    message: 'expiresAt requires a value',
  })

const BROWSER_STORAGE_MAX = 20

/** (kind, name) pairs are matched exactly (case-sensitive) — the same rule the
 * update merge uses — so two rows with the same pair would be ambiguous. */
function rejectDuplicatePairs(rows: { kind: string; name: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>()
  for (const [index, row] of rows.entries()) {
    const key = `${row.kind}\n${row.name}`
    if (seen.has(key))
      ctx.addIssue({
        code: 'custom',
        path: [index, 'name'],
        message: `duplicate browser storage item "${row.kind}:${row.name}"`,
      })
    seen.add(key)
  }
}

export const BrowserStorageSchema = z
  .array(BrowserStorageItemSchema)
  .max(BROWSER_STORAGE_MAX)
  .superRefine(rejectDuplicatePairs)
export const BrowserStoragePatchesSchema = z
  .array(BrowserStoragePatchSchema)
  .max(BROWSER_STORAGE_MAX)
  .superRefine(rejectDuplicatePairs)

export type BrowserStorageItem = z.infer<typeof BrowserStorageItemSchema>
export type BrowserStoragePatch = z.infer<typeof BrowserStoragePatchSchema>

/** What the API exposes about stored items: never the value. */
export interface BrowserStorageName {
  kind: BrowserStorageKind
  name: string
}
