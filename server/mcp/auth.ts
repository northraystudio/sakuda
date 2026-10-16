import { createHash, timingSafeEqual } from 'node:crypto'
import { isLoopbackRequest } from '../lib/loopback'

export type McpAuth =
  { ok: true; authenticated: boolean } | { ok: false; status: 401 | 403; message: string }

/** Hashing both sides first gives equal-length buffers, so the comparison
 * time does not depend on where (or whether) the lengths differ. */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * With no key configured, MCP stays an unauthenticated loopback tool like the
 * rest of the API, and `authenticated` is false — so secrets are never
 * revealed. With a key configured, every request must carry
 * `Authorization: Bearer <key>`.
 */
export function checkMcpRequest(
  headers: { host: string | null; origin: string | null; authorization: string | null },
  apiKey: string | undefined,
): McpAuth {
  if (!isLoopbackRequest(headers.host, headers.origin))
    return { ok: false, status: 403, message: 'MCP accepts loopback Host/Origin only' }
  if (apiKey === undefined) return { ok: true, authenticated: false }

  const match = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')
  if (!match?.[1] || !sameSecret(match[1].trim(), apiKey))
    return { ok: false, status: 401, message: 'missing or invalid MCP API key' }
  return { ok: true, authenticated: true }
}
