import { detectAuthCheckHint } from '../domain/authCheck'
import { joinUrl } from '../domain/hostAlias'
import type { Logger } from '../lib/logger'
import { AUTH_CHECK_TIMEOUT_MS, type AuthCheckSend } from './authWatch'
import type { SiteWithHeaders } from './siteService'
import type { ScanBlockedEntry, ScanEntry } from '#shared/types/api'

export interface EntryCheckOptions {
  site: Pick<SiteWithHeaders, 'frontBaseUrl' | 'apiBaseUrl' | 'headers'>
  /** The auth check's sender (#79): same localhost alias as the engines, and
   * it reads only the start of a 401/403 body. */
  send: AuthCheckSend
  logger: Logger
  /** The scan's signal, so Stop scan also stops a slow check. */
  signal: AbortSignal
}

/**
 * Scan-start entry check (#82): one GET to each base URL of the site, with
 * its headers, to notice a block page served by something in front of the
 * target (e.g. Vite's `allowedHosts`) — every engine request would hit it
 * too. Uses the auth check's block-page rule. A request that gets no answer
 * is logged and skipped; it never stops the scan.
 */
export async function findBlockedEntries(o: EntryCheckOptions): Promise<ScanBlockedEntry[]> {
  const front = joinUrl(o.site.frontBaseUrl, '')
  const api = o.site.apiBaseUrl ? joinUrl(o.site.apiBaseUrl, '') : null
  const entries: [ScanEntry, string][] = [['front', front]]
  if (api && api !== front) entries.push(['api', api])

  const blocked: ScanBlockedEntry[] = []
  for (const [entry, url] of entries) {
    try {
      const answer = await o.send(
        url,
        o.site.headers,
        AbortSignal.any([o.signal, AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS)]),
      )
      if (detectAuthCheckHint(answer) === 'blocked-before-app')
        blocked.push({ entry, status: answer.status })
    } catch (e) {
      o.logger.warn(
        { operation: 'entryCheck', entry, err: e instanceof Error ? e.message : String(e) },
        'entry check got no answer; the scan continues without it',
      )
    }
  }
  return blocked
}
