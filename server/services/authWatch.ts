import {
  AUTH_CHECK_BODY_HEAD_BYTES,
  detectAuthCheckHint,
  isLoginRejected,
  resolveAuthCheckUrl,
  type AuthCheckAnswer,
} from '../domain/authCheck'
import { rewriteLoopbackHost } from '../domain/hostAlias'
import type { Logger } from '../lib/logger'
import type { SiteWithHeaders } from './siteService'
import type { Header } from '#shared/schemas/headers'
import type { ScanAuthLost } from '#shared/types/api'

/** How often a running scan re-checks its login (#74). */
export const AUTH_CHECK_INTERVAL_MS = 60_000
/** Per-request timeout of one auth check. */
export const AUTH_CHECK_TIMEOUT_MS = 10_000

/** Sends one auth check and answers the HTTP status (plus, for a 401/403,
 * the start of the body — see `AuthCheckAnswer`). */
export type AuthCheckSend = (
  url: string,
  headers: Header[],
  signal: AbortSignal,
) => Promise<AuthCheckAnswer>

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
    if (!isLoginRejected(res.status)) {
      await res.body?.cancel()
      return { status: res.status, bodyHead: null }
    }
    try {
      return { status: res.status, bodyHead: await readBodyHead(res, AUTH_CHECK_BODY_HEAD_BYTES) }
    } catch (e) {
      // The status is the verdict; a body that will not read only loses the hint.
      return {
        status: res.status,
        bodyHead: null,
        bodyReadError: e instanceof Error ? e.message : String(e),
      }
    }
  }
}

/** Reads at most `maxBytes` of the body and drops the rest unread. The
 * request's signal also bounds this read. */
async function readBodyHead(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      // Keep only what still fits, so the copy below is never larger than maxBytes.
      const kept = value.subarray(0, maxBytes - total)
      chunks.push(kept)
      total += kept.byteLength
    }
  } finally {
    await reader.cancel()
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total))
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
    let answer: AuthCheckAnswer
    try {
      answer = await o.config.send(
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
    const { status } = answer
    if (isLoginRejected(status)) {
      stopped = true
      if (answer.bodyReadError)
        o.logger.warn(
          { operation: 'authCheck', path, status, err: answer.bodyReadError },
          'could not read the rejection body; recording the lost login without a hint',
        )
      const hint = detectAuthCheckHint(answer)
      o.onLost({ detectedAt: o.now().toISOString(), path, status, ...(hint ? { hint } : {}) })
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
