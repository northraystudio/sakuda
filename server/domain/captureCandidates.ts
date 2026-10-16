import { BROWSER_STORAGE_MAX, BrowserStorageItemSchema } from '#shared/schemas/browserStorage'
import { HeaderSchema } from '#shared/schemas/headers'
import type { CapturedHeader, CaptureResult, CapturedStorageItem } from '#shared/types/api'

/** What a capture read from the login tab (see server/capture/cdp). */
export interface CaptureInput {
  cookies: { name: string; value: string; expires?: number }[]
  localStorage: [string, string][]
  sessionStorage: [string, string][]
}

// A whole value that is a JWT (optionally already "Bearer <jwt>").
const JWT_VALUE = /^(?:Bearer\s+)?(eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*)$/

function cookieExpiry(expires: number | undefined): string | undefined {
  // CDP reports -1 (or 0) for a session cookie: no expiry to record.
  return expires !== undefined && expires > 0 ? new Date(expires * 1000).toISOString() : undefined
}

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? 'invalid value'
}

/**
 * Turns a capture into edit-form row proposals (#17):
 * - every cookie / localStorage / sessionStorage entry as a browser-storage row,
 * - one `Cookie` header joining the cookies, for the engines that only send headers,
 * - an `Authorization: Bearer` header when a stored value is a JWT.
 * Each row is checked against the same schema a typed row must pass; what
 * fails is reported in `skipped`, never silently dropped.
 */
export function buildCaptureCandidates(input: CaptureInput): CaptureResult {
  const skipped: CaptureResult['skipped'] = []
  const raw: CapturedStorageItem[] = [
    ...input.localStorage.map(([name, value]) => ({ kind: 'localStorage' as const, name, value })),
    ...input.sessionStorage.map(([name, value]) => ({
      kind: 'sessionStorage' as const,
      name,
      value,
    })),
    ...input.cookies.map((c) => {
      const expiresAt = cookieExpiry(c.expires)
      return {
        kind: 'cookie' as const,
        name: c.name,
        value: c.value,
        ...(expiresAt && { expiresAt }),
      }
    }),
  ]

  const valid: CapturedStorageItem[] = []
  for (const item of raw) {
    const label = `${item.kind}:${item.name}`
    const r = BrowserStorageItemSchema.safeParse(item)
    if (!r.success) skipped.push({ item: label, reason: firstIssue(r.error) })
    else if (valid.length >= BROWSER_STORAGE_MAX)
      skipped.push({ item: label, reason: `over the ${BROWSER_STORAGE_MAX}-item limit` })
    else valid.push(item)
  }

  const headers: CapturedHeader[] = []
  const cookies = valid.filter((i) => i.kind === 'cookie')
  if (cookies.length > 0) {
    const expiries = cookies.flatMap((c) => (c.expiresAt ? [c.expiresAt] : [])).sort()
    headers.push({
      name: 'Cookie',
      value: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      ...(expiries[0] && { expiresAt: expiries[0] }),
    })
  }
  const jwt = valid.map((i) => JWT_VALUE.exec(i.value)?.[1]).find((t) => t !== undefined)
  if (jwt) headers.push({ name: 'Authorization', value: `Bearer ${jwt}` })

  const validHeaders = headers.filter((h) => {
    const r = HeaderSchema.safeParse(h)
    if (!r.success) skipped.push({ item: `header:${h.name}`, reason: firstIssue(r.error) })
    return r.success
  })

  return { headers: validHeaders, browserStorage: valid, skipped }
}
