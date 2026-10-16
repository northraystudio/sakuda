/**
 * Expiry of stored auth secrets (#17). Expiry times are not secret, so they
 * live in plaintext (`sites.secret_expiries`) keyed by `secretKey`, and a
 * scan can warn about an expired or soon-expiring login without decrypting
 * anything. Pure functions only; the parts the UI also needs (key format,
 * expiry check) live in shared/utils/secretExpiry.
 */
// A JWT's header and payload are base64url JSON objects, so both start with
// `eyJ` ("{\"" encoded). Matches a bare token, "Bearer <jwt>" and a JWT
// inside a cookie string alike.
const JWT_PATTERN = /eyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]*/g

function decodeJwtExp(payload: string): number | null {
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof claims !== 'object' || claims === null || !('exp' in claims)) return null
    const exp = claims.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
  } catch {
    return null // not a JWT after all — no expiry to report
  }
}

/** Earliest `exp` of any JWT found in the value (signature not verified —
 * only used to warn), or null when there is none. */
export function jwtExpiry(value: string): string | null {
  let earliest: number | null = null
  for (const match of value.matchAll(JWT_PATTERN)) {
    const exp = match[1] ? decodeJwtExp(match[1]) : null
    if (exp !== null && (earliest === null || exp < earliest)) earliest = exp
  }
  return earliest === null ? null : new Date(earliest * 1000).toISOString()
}

export interface SecretExpiryEntry {
  key: string
  value: string
  /** Explicit expiry sent with a new value (a captured cookie's `expires`). */
  expiresAt?: string
  /** true when the update kept the stored value (name-only patch row). */
  kept: boolean
}

/**
 * Expiries of the secrets that remain after an update: an explicit expiry
 * wins, a kept value keeps its previous expiry, otherwise a JWT `exp` in the
 * value is used. Secrets with no known expiry are left out, and so are keys
 * that no longer exist.
 */
export function resolveSecretExpiries(
  entries: SecretExpiryEntry[],
  previous: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of entries) {
    const expiry = e.expiresAt ?? (e.kept ? previous[e.key] : undefined) ?? jwtExpiry(e.value)
    if (expiry) out[e.key] = expiry
  }
  return out
}
