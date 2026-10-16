import { createHash, timingSafeEqual } from 'node:crypto'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Hostname of a `Host` header value or an origin URL, port dropped. */
function hostnameOf(value: string, isOrigin: boolean): string | null {
  try {
    return new URL(isOrigin ? value : `http://${value}`).hostname.toLowerCase()
  } catch {
    return null // unparseable → treated as not loopback by the caller
  }
}

/** DNS-rebinding guard: a page on an attacker's domain that re-resolves to
 * 127.0.0.1 still sends its own name in `Host`, and a browser always sends
 * `Origin` on a cross-origin POST. Only loopback names pass. A missing
 * `Origin` is allowed — CLI MCP clients do not send one. */
export function isLoopbackRequest(host: string | null, origin: string | null): boolean {
  if (!host) return false
  const hostName = hostnameOf(host, false)
  if (!hostName || !LOOPBACK_HOSTS.has(hostName)) return false
  if (origin === null) return true
  const originName = hostnameOf(origin, true)
  return originName !== null && LOOPBACK_HOSTS.has(originName)
}

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
