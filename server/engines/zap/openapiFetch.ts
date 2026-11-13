import { restoreLoopbackHost, rewriteLoopbackHost } from '../../domain/hostAlias'
import { EngineError } from '../types'
import type { Header } from '#shared/schemas/headers'
import { isLocalUrl } from '#shared/utils/localHost'

/** Redirects followed before giving up. */
export const OPENAPI_FETCH_MAX_REDIRECTS = 5
/** Wall-clock budget for the whole fetch, redirects included. */
export const OPENAPI_FETCH_TIMEOUT_MS = 30_000
/** Largest document accepted; anything bigger is refused, not truncated. */
export const OPENAPI_FETCH_MAX_BYTES = 10_000_000

export interface OpenapiFetchInput {
  /** The saved (un-aliased) OpenAPI URL. */
  url: string
  /** Saved base URLs / origins the fetch may reach: the site's front, API and
   * extra OpenAPI origins. The URL's own origin is always allowed. */
  allowedOrigins: string[]
  /** The site's headers — sent like ZAP's replacer sent them, and only to an
   * allowed origin, since every hop is checked before it is sent. */
  headers: Header[]
  localhostAlias: string | undefined
  signal: AbortSignal
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Fetches the site's OpenAPI document for zap-api, following redirects by
 * hand so each hop is checked against the site's origins before it is sent.
 * ZAP's openapi job follows a redirect to any host (#57): an allowed origin
 * that redirects elsewhere would make sakuda reach a host the user never
 * confirmed. A hop off the allowed origins is refused; so is a hop from a
 * non-local URL to a local (internal) one. Only a local start may move to
 * another local host, since local hosts need no confirmation anyway.
 */
export async function fetchOpenapiDoc(i: OpenapiFetchInput): Promise<string> {
  const fetchImpl = i.fetchImpl ?? fetch
  const allowed = new Set(
    [i.url, ...i.allowedOrigins].filter((u) => URL.canParse(u)).map((u) => new URL(u).origin),
  )
  const startIsLocal = isLocalUrl(i.url)
  const signal = AbortSignal.any([
    i.signal,
    AbortSignal.timeout(i.timeoutMs ?? OPENAPI_FETCH_TIMEOUT_MS),
  ])

  let current = i.url
  for (let hop = 0; hop <= OPENAPI_FETCH_MAX_REDIRECTS; hop++) {
    const origin = new URL(current).origin
    if (!allowed.has(origin) && !(startIsLocal && isLocalUrl(current)))
      throw new EngineError(
        `zap-api: the OpenAPI URL redirected to ${origin}, which is not the site's front, API or ` +
          'OpenAPI origin nor an extra origin allowed for it, so sakuda did not follow it. If that ' +
          'host is intended, allow it for the site in the sakuda UI, or paste the document as JSON',
      )
    const headers = new Headers()
    for (const h of i.headers) headers.set(h.name, h.value)
    headers.set('accept', 'application/json, application/yaml;q=0.9, */*;q=0.8')
    const requestUrl = rewriteLoopbackHost(current, i.localhostAlias)
    let res: Response
    try {
      res = await fetchImpl(requestUrl, { method: 'GET', headers, redirect: 'manual', signal })
    } catch (e) {
      throw new EngineError(
        `zap-api: could not fetch the OpenAPI document from ${origin} (${errorName(e)}) — check ` +
          'the OpenAPI URL is reachable from sakuda',
        undefined,
        { cause: e },
      )
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel()
      const location = res.headers.get('location')
      if (!location)
        throw new EngineError(
          `zap-api: ${origin} answered HTTP ${res.status} to the OpenAPI URL without a Location header`,
        )
      // Resolved against the URL actually requested, then mapped back from the
      // loopback alias so the origin check compares saved origins.
      current = restoreLoopbackHost(
        new URL(location, requestUrl).toString(),
        i.localhostAlias,
        new URL(current).hostname,
      )
      continue
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new EngineError(
        `zap-api: ${origin} answered HTTP ${res.status} to the OpenAPI URL — check the URL and, ` +
          'if it needs a login, the site’s headers',
      )
    }
    return readWithin(res, origin)
  }
  throw new EngineError(
    `zap-api: the OpenAPI URL redirected more than ${OPENAPI_FETCH_MAX_REDIRECTS} times — paste the document as JSON instead`,
  )
}

/** Reads the body, refusing (not truncating) one over the size cap: a cut
 * document would import as a different API. */
async function readWithin(res: Response, origin: string): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > OPENAPI_FETCH_MAX_BYTES) {
      await reader.cancel()
      throw new EngineError(
        `zap-api: the OpenAPI document from ${origin} is larger than ${OPENAPI_FETCH_MAX_BYTES} bytes — paste a smaller document as JSON`,
      )
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** A short reason for a failed request: the timeout, or the socket error code
 * (`ECONNREFUSED`…) that undici keeps under `cause`. */
function errorName(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown error'
  if (e.name === 'TimeoutError') return 'timed out'
  const cause: unknown = e.cause
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') return cause.code
  return e.name
}
