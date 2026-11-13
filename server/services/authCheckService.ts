import { classifyAuthStatus, resolveAuthCheckUrl } from '../domain/authCheck'
import type { Logger } from '../lib/logger'
import { AUTH_CHECK_TIMEOUT_MS, type AuthCheckSend } from './authWatch'
import { ServiceError } from './errors'
import { loadSiteWithHeaders, mergeHeaderPatches, type SiteServiceDeps } from './siteService'
import type { AuthCheckInput } from '#shared/schemas/site'
import type { Header } from '#shared/schemas/headers'
import type { AuthCheckResult, SitePublic } from '#shared/types/api'

export interface AuthCheckDeps {
  site: SiteServiceDeps
  send: AuthCheckSend
  logger: Logger
}

type CheckTarget = Pick<SitePublic, 'frontBaseUrl' | 'apiBaseUrl'> & {
  authCheckPath: string
  headers: Header[]
}

/** Sends one login check and reads the answer. No header value ever leaves
 * this function — the result carries the path and status only. */
async function checkOnce(deps: AuthCheckDeps, target: CheckTarget): Promise<AuthCheckResult> {
  const path = target.authCheckPath
  const url = resolveAuthCheckUrl(target)
  if (!url)
    throw new ServiceError(
      422,
      'VALIDATION',
      `authCheckPath "${path}" needs an API base URL (it starts with "api:")`,
    )
  try {
    const status = await deps.send(url, target.headers, AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS))
    return { outcome: classifyAuthStatus(status), status, path }
  } catch (e) {
    deps.logger.warn(
      { operation: 'authCheck.once', path, err: e instanceof Error ? e.message : String(e) },
      'login check got no answer (timeout or connection error) — check the base URL is reachable from sakuda',
    )
    return { outcome: 'no-answer', status: null, path }
  }
}

/**
 * The form's Check button (#74): checks the values being edited, before they
 * are saved. With a `siteId`, header rows without a value use the stored one
 * (the same merge a save does); without one (a new site) every row needs its
 * value. The input schema has already confined the URL to the given origins
 * and required the non-local confirmation.
 */
export async function checkAuthDraft(
  deps: AuthCheckDeps,
  siteId: string | null,
  input: AuthCheckInput,
): Promise<AuthCheckResult> {
  let stored: Header[] = []
  if (siteId !== null) {
    const site = loadSiteWithHeaders(deps.site, siteId)
    if (!site) throw new ServiceError(404, 'SITE_NOT_FOUND', `site ${siteId} not found`)
    stored = site.headers
  }
  return checkOnce(deps, {
    frontBaseUrl: input.frontBaseUrl,
    apiBaseUrl: input.apiBaseUrl,
    authCheckPath: input.authCheckPath,
    headers: mergeHeaderPatches(stored, input.headers),
  })
}

/** MCP `check_auth`: checks a site with its saved settings only — an agent
 * never holds the secret values, so there is no draft to check. */
export async function checkSavedSiteAuth(
  deps: AuthCheckDeps,
  siteId: string,
): Promise<AuthCheckResult> {
  const site = loadSiteWithHeaders(deps.site, siteId)
  if (!site) throw new ServiceError(404, 'SITE_NOT_FOUND', `site ${siteId} not found`)
  if (!site.authCheckPath)
    throw new ServiceError(
      409,
      'AUTH_CHECK_NOT_SET',
      `site ${siteId} has no authCheckPath — set one (e.g. "/account" or "api:/me") first`,
    )
  if (site.requiresConfirmation && !site.nonLocalConfirmed)
    throw new ServiceError(
      409,
      'NON_LOCAL_NOT_CONFIRMED',
      `site ${siteId} targets a non-local host the user has not confirmed in the sakuda UI`,
    )
  return checkOnce(deps, { ...site, authCheckPath: site.authCheckPath })
}
