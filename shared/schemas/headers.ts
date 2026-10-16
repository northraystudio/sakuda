import { z } from 'zod'

const HeaderName = z
  .string()
  .min(1)
  .regex(/^[^\s:]+$/, 'header name must not contain whitespace or ":"')

const HeaderValue = z
  .string()
  .min(1)
  .regex(/^[^\r\n]*$/, 'header value must not contain CR/LF')

export const HeaderSchema = z.object({ name: HeaderName, value: HeaderValue })

/** One row of a site update: a missing `value` means "keep the stored value
 * for this name" — the merge itself lives in `siteService.updateSite`. */
export const HeaderPatchSchema = z
  .object({
    name: HeaderName,
    value: HeaderValue.optional(),
    /** Known expiry of a new value (set by auth capture, #17). */
    expiresAt: z.iso.datetime().optional(),
  })
  .refine((h) => h.expiresAt === undefined || h.value !== undefined, {
    path: ['expiresAt'],
    message: 'expiresAt requires a value',
  })

const HEADERS_MAX = 20

/** Names are matched exactly (case-sensitive) — the same rule the update
 * merge uses — so two rows with the same name would be ambiguous. */
function rejectDuplicateNames(rows: { name: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>()
  for (const [index, row] of rows.entries()) {
    if (seen.has(row.name))
      ctx.addIssue({
        code: 'custom',
        path: [index, 'name'],
        message: `duplicate header name "${row.name}"`,
      })
    seen.add(row.name)
  }
}

export const HeadersSchema = z
  .array(HeaderSchema)
  .max(HEADERS_MAX)
  .superRefine(rejectDuplicateNames)
export const HeaderPatchesSchema = z
  .array(HeaderPatchSchema)
  .max(HEADERS_MAX)
  .superRefine(rejectDuplicateNames)

export type Header = z.infer<typeof HeaderSchema>
export type HeaderPatch = z.infer<typeof HeaderPatchSchema>
