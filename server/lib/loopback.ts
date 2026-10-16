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
 * `Origin` is allowed — CLI MCP clients do not send one, nor does a browser
 * on a same-origin GET. Used by every route that hands out secrets (MCP,
 * the site secrets endpoint, auth capture). */
export function isLoopbackRequest(host: string | null, origin: string | null): boolean {
  if (!host) return false
  const hostName = hostnameOf(host, false)
  if (!hostName || !LOOPBACK_HOSTS.has(hostName)) return false
  if (origin === null) return true
  const originName = hostnameOf(origin, true)
  return originName !== null && LOOPBACK_HOSTS.has(originName)
}
