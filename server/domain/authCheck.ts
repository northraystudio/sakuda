import { joinUrl } from './hostAlias'
import type { AuthCheckOutcome, SitePublic } from '#shared/types/api'

/**
 * The URL a scan's auth check GETs (#74), or null when the site has none.
 * The path is always joined onto the site's own front (or, with `api:`, API)
 * base, so the check can never leave the saved origins — `joinUrl` also
 * collapses a leading `//`, which would otherwise read as another host.
 */
export function resolveAuthCheckUrl(
  site: Pick<SitePublic, 'frontBaseUrl' | 'apiBaseUrl' | 'authCheckPath'>,
): string | null {
  const raw = site.authCheckPath
  if (!raw) return null
  const onApi = raw.startsWith('api:')
  const base = onApi ? site.apiBaseUrl : site.frontBaseUrl
  if (!base) return null
  return joinUrl(base, onApi ? raw.slice('api:'.length) : raw)
}

/** How a one-off check (the form's Check button, MCP `check_auth`) reads a
 * status. A redirect is called out on its own: a site that answers a
 * logged-out request with 302 cannot be watched through this path, since
 * the scan only treats 401/403 as a lost login. */
export function classifyAuthStatus(status: number): Exclude<AuthCheckOutcome, 'no-answer'> {
  if (isLoginRejected(status)) return 'rejected'
  if (status >= 200 && status < 300) return 'ok'
  if (status >= 300 && status < 400) return 'redirect'
  return 'unexpected'
}

/** 401 / 403 is the target saying "not logged in" — anything else (2xx, a
 * redirect, a 5xx) is not treated as a lost login. */
export function isLoginRejected(status: number): boolean {
  return status === 401 || status === 403
}
