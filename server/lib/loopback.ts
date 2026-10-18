const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Hostname of a `Host` header value or an origin URL, port dropped. */
export function hostnameOf(value: string, isOrigin: boolean): string | null {
  try {
    return new URL(isOrigin ? value : `http://${value}`).hostname.toLowerCase()
  } catch {
    return null // unparseable → treated as not loopback by the caller
  }
}

/** DNS-rebinding guard: a page on an attacker's domain that re-resolves to
 * 127.0.0.1 still sends its own name in `Host`, and a browser always sends
 * `Origin` on a cross-origin POST. Only loopback names pass, plus the
 * hostnames listed in `allowedHosts` (`SAKUDA_ALLOWED_HOSTS`, #22; MCP never
 * passes any). A missing `Origin` is allowed — CLI MCP clients do not send
 * one, nor does a browser on a same-origin GET. Used by the `/api/**`
 * middleware and by MCP. */
export function isLoopbackRequest(
  host: string | null,
  origin: string | null,
  allowedHosts: readonly string[] = [],
): boolean {
  const accepts = (name: string | null): boolean =>
    name !== null && (LOOPBACK_HOSTS.has(name) || allowedHosts.includes(name))
  if (!host || !accepts(hostnameOf(host, false))) return false
  return origin === null || accepts(hostnameOf(origin, true))
}

/** The router sees the raw request target, so compare a normalized form:
 * `//api/x`, `/API/x`, `/%61pi/x` and `/x/../api/x` must not slip past the
 * guard. An undecodable path is treated as guarded (deny by default). */
export function isApiPath(rawPath: string): boolean {
  // Slashes are collapsed before parsing: `//api/x` would otherwise read as a
  // protocol-relative URL with host `api`. A decoded `?`/`#` is re-encoded so
  // it stays part of the path instead of cutting it short.
  const pathnameOf = (p: string): string =>
    new URL(p.replace(/\/{2,}/g, '/'), 'http://guard.invalid').pathname
  let path: string
  try {
    const decoded = decodeURIComponent(pathnameOf(rawPath)).replace(/[?#]/g, encodeURIComponent)
    path = pathnameOf(decoded).toLowerCase()
  } catch {
    return true
  }
  return path === '/api' || path.startsWith('/api/')
}
