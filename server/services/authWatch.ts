import { isLoginRejected, resolveAuthCheckUrl } from '../domain/authCheck'
import { rewriteLoopbackHost } from '../domain/hostAlias'
import type { Logger } from '../lib/logger'
import type { SiteWithHeaders } from './siteService'
import type { Header } from '#shared/schemas/headers'
import type { ScanAuthLost } from '#shared/types/api'

/** How often a running scan re-checks its login (#74). */
export const AUTH_CHECK_INTERVAL_MS = 60_000
/** Per-request timeout of one auth check. */
export const AUTH_CHECK_TIMEOUT_MS = 10_000

/** Sends one auth check and answers the HTTP status. */
export type AuthCheckSend = (url: string, headers: Header[], signal: AbortSignal) => Promise<number>

export interface AuthCheckConfig {
  send: AuthCheckSend
  intervalMs: number
}

/** The real sender: a GET with the site's headers, redirects not followed
 * (a login redirect is the target's answer, not a page to load). */
export function fetchAuthStatus(localhostAlias: string | undefined): AuthCheckSend {
  return async (url, headers, signal) => {
    const h = new Headers()
    for (const { name, value } of headers) h.set(name, value)
    const res = await fetch(rewriteLoopbackHost(url, localhostAlias), {
      method: 'GET',
      headers: h,
      redirect: 'manual',
      signal,
    })
    await res.body?.cancel()
    return res.status
  }
}

export interface AuthWatchOptions {
  site: SiteWithHeaders
  config: AuthCheckConfig
  logger: Logger
  now: () => Date
  /** Called at most once, with the first rejection seen. */
  onLost: (lost: ScanAuthLost) => void
}

export interface AuthWatch {
  /** Stops checking and waits for an in-flight check to settle. */
  stop(): Promise<void>
}

/**
 * Checks the site's login now and then every `intervalMs` until stopped or
 * until the first rejection (401/403), which is reported once through
 * `onLost`. A check that fails to get an answer (timeout, connection error)
 * is logged and retried on the next tick — it says nothing about the login.
 * Returns null when the site has no auth check configured.
 */
export function startAuthWatch(o: AuthWatchOptions): AuthWatch | null {
  const path = o.site.authCheckPath
  const url = resolveAuthCheckUrl(o.site)
  if (!path || !url) return null
  const ac = new AbortController()
  let timer: NodeJS.Timeout | null = null
  let inFlight: Promise<void> = Promise.resolve()
  let stopped = false

  const check = async (): Promise<void> => {
    let status: number
    try {
      status = await o.config.send(
        url,
        o.site.headers,
        AbortSignal.any([ac.signal, AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS)]),
      )
    } catch (e) {
      if (!stopped)
        o.logger.warn(
          { operation: 'authCheck', path, err: e instanceof Error ? e.message : String(e) },
          'auth check got no answer; retrying on the next interval',
        )
      schedule()
      return
    }
    if (stopped) return
    if (isLoginRejected(status)) {
      stopped = true
      o.onLost({ detectedAt: o.now().toISOString(), path, status })
      return
    }
    schedule()
  }

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      inFlight = check()
    }, o.config.intervalMs)
  }

  inFlight = check()
  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      ac.abort()
      await inFlight
    },
  }
}
