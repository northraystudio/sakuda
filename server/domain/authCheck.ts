import { joinUrl } from './hostAlias'
import type { AuthCheckHint, AuthCheckOutcome, SitePublic } from '#shared/types/api'

/** What one auth-check request answered. `bodyHead` is the start of the body
 * of a 401/403 (at most `AUTH_CHECK_BODY_HEAD_BYTES`), read only to tell a
 * block page apart from the target's own rejection; null for other statuses
 * or when the body could not be read. It is never stored or logged. */
export interface AuthCheckAnswer {
  status: number
  bodyHead: string | null
  /** Why the body could not be read, for the caller to log. */
  bodyReadError?: string
}

/** How much of a 401/403 body is read — enough for a block page's first line. */
export const AUTH_CHECK_BODY_HEAD_BYTES = 1024

/** Opening text of block pages served by something in front of the target
 * app, not by the app itself (#79). Exact phrases only, so the target's own
 * 401/403 — JSON, HTML or plain text — never gets the hint. Add one line per
 * block page met in practice. */
const BLOCKED_BEFORE_APP_PHRASES: readonly string[] = [
  // Vite dev server's host check (`server.allowedHosts`).
  'Blocked request. This host',
]

/** `blocked-before-app` when a 401/403 body is a known block page; the
 * verdict itself stays `rejected` — this only explains it. */
export function detectAuthCheckHint(answer: AuthCheckAnswer): AuthCheckHint | null {
  const { status, bodyHead } = answer
  if (!isLoginRejected(status) || !bodyHead) return null
  return BLOCKED_BEFORE_APP_PHRASES.some((p) => bodyHead.includes(p)) ? 'blocked-before-app' : null
}

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
