import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Minimal Chrome DevTools Protocol client for auth capture (#17), built on
 * Node's global `fetch` and `WebSocket` — no dependency. It drives the host
 * Chrome that `make capture-browser` starts: open a tab on the target, and
 * later read that tab's cookies (HttpOnly included) and web storage.
 */

export type CdpErrorCode = 'CDP_UNREACHABLE' | 'TAB_NOT_FOUND' | 'WRONG_ORIGIN' | 'CDP_PROTOCOL'

export class CdpError extends Error {
  constructor(
    public readonly code: CdpErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CdpError'
  }
}

export interface CdpOptions {
  /** DevTools HTTP endpoint, e.g. `http://host.docker.internal:9222` (env only). */
  baseUrl: string
  timeoutMs: number
}

export interface CdpCookie {
  name: string
  value: string
  /** Seconds since epoch; -1 (or absent) for a session cookie. */
  expires?: number
}

export interface CapturedTab {
  origin: string
  cookies: CdpCookie[]
  localStorage: [string, string][]
  sessionStorage: [string, string][]
}

/** DevTools target ids are 32 hex chars; anything else never reaches a URL path. */
const TARGET_ID = /^[0-9A-F]{32}$/i

export function isTargetId(id: string): boolean {
  return TARGET_ID.test(id)
}

/**
 * Chrome answers its DevTools HTTP endpoint only when `Host` is an IP or
 * `localhost` (its own DNS-rebinding guard), so a name such as
 * host.docker.internal is resolved to its IPv4 address first.
 */
export async function resolveCdpBase(baseUrl: string): Promise<URL> {
  const url = new URL(baseUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) === 0 && host !== 'localhost') {
    try {
      url.hostname = (await lookup(host, { family: 4 })).address
    } catch (err) {
      throw new CdpError(
        'CDP_UNREACHABLE',
        `cannot resolve ${host} for the capture browser (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }
  return url
}

const UNREACHABLE_HINT =
  'start it with `make capture-browser` (Chrome with --remote-debugging-port) and retry'

async function cdpHttp(
  base: URL,
  path: string,
  opts: CdpOptions,
  method: 'GET' | 'PUT' = 'GET',
): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(new URL(path, base), { method, signal: AbortSignal.timeout(opts.timeoutMs) })
  } catch (err) {
    throw new CdpError(
      'CDP_UNREACHABLE',
      `capture browser not reachable at ${base.origin} (${err instanceof Error ? err.message : String(err)}) — ${UNREACHABLE_HINT}`,
    )
  }
  const text = await res.text()
  if (!res.ok)
    throw new CdpError(
      'CDP_PROTOCOL',
      `DevTools ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`,
    )
  try {
    return JSON.parse(text)
  } catch {
    return text // /json/close answers plain text
  }
}

interface TargetInfo {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

function isTargetInfo(v: unknown): v is TargetInfo {
  return (
    typeof v === 'object' &&
    v !== null &&
    'id' in v &&
    typeof v.id === 'string' &&
    'type' in v &&
    typeof v.type === 'string' &&
    'url' in v &&
    typeof v.url === 'string'
  )
}

/** Opens a new tab on `url` in the capture browser and returns its target id. */
export async function openTab(url: string, opts: CdpOptions): Promise<string> {
  const base = await resolveCdpBase(opts.baseUrl)
  const target = await cdpHttp(base, `/json/new?${encodeURIComponent(url)}`, opts, 'PUT')
  if (!isTargetInfo(target) || !isTargetId(target.id))
    throw new CdpError('CDP_PROTOCOL', 'DevTools /json/new returned no target id')
  return target.id
}

/**
 * Shuts the capture browser down once a capture is done (`Browser.close`), so
 * its DevTools port — which anything on the host, and any container through
 * host.docker.internal, could drive — is not left open. An already-closed
 * browser is not an error.
 */
export async function closeBrowser(opts: CdpOptions): Promise<void> {
  const base = await resolveCdpBase(opts.baseUrl)
  const version = await cdpHttp(base, '/json/version', opts)
  const wsRaw =
    typeof version === 'object' && version !== null && 'webSocketDebuggerUrl' in version
      ? version.webSocketDebuggerUrl
      : undefined
  if (typeof wsRaw !== 'string')
    throw new CdpError('CDP_PROTOCOL', 'DevTools /json/version returned no browser socket')
  const wsUrl = new URL(wsRaw)
  wsUrl.host = base.host
  await withSession(wsUrl.toString(), opts, async (send) => {
    // Chrome drops the connection while exiting, so the reply may never come.
    await send('Browser.close').catch((err: unknown) => {
      if (!(err instanceof CdpError && err.code === 'CDP_PROTOCOL')) throw err
    })
  })
}

async function findPageTarget(base: URL, targetId: string, opts: CdpOptions): Promise<TargetInfo> {
  const list = await cdpHttp(base, '/json/list', opts)
  const target = Array.isArray(list)
    ? list.filter(isTargetInfo).find((t) => t.id === targetId && t.type === 'page')
    : undefined
  if (!target?.webSocketDebuggerUrl)
    throw new CdpError(
      'TAB_NOT_FOUND',
      'the login tab is gone (closed?) — press "Log in with browser" again',
    )
  return target
}

/** One WebSocket session to a page target: request/response by id. */
async function withSession<T>(
  wsUrl: string,
  opts: CdpOptions,
  fn: (send: (method: string, params?: object) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(wsUrl)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 0
  ws.addEventListener('message', (event) => {
    let msg: unknown
    try {
      msg = JSON.parse(String(event.data))
    } catch {
      return // not a protocol frame
    }
    if (typeof msg !== 'object' || msg === null || !('id' in msg) || typeof msg.id !== 'number')
      return
    const waiter = pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id)
    if ('error' in msg && msg.error)
      waiter.reject(new CdpError('CDP_PROTOCOL', JSON.stringify(msg.error)))
    else waiter.resolve('result' in msg ? msg.result : undefined)
  })
  const failAll = (reason: string) => {
    for (const w of pending.values()) w.reject(new CdpError('CDP_PROTOCOL', reason))
    pending.clear()
  }
  ws.addEventListener('close', () => failAll('DevTools connection closed'))

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpError('CDP_UNREACHABLE', 'DevTools WebSocket did not open in time'))
    }, opts.timeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new CdpError('CDP_UNREACHABLE', 'DevTools WebSocket failed to open'))
    })
  })

  const send = (method: string, params: object = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new CdpError('CDP_PROTOCOL', `DevTools ${method} timed out`))
      }, opts.timeoutMs)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  try {
    return await fn(send)
  } finally {
    ws.close()
  }
}

// Runs inside the target page: its own origin plus both web storages.
const READ_STORAGE = `JSON.stringify({
  origin: location.origin,
  local: Object.entries(localStorage),
  session: Object.entries(sessionStorage),
})`

function isStringPairs(v: unknown): v is [string, string][] {
  return (
    Array.isArray(v) &&
    v.every((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string')
  )
}

/** `Runtime.evaluate` answers `{ result: RemoteObject }`; with
 * `returnByValue` the JSON string sits in `result.value`. */
function evaluatedValue(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('result' in result)) return undefined
  const remote = result.result
  return typeof remote === 'object' && remote !== null && 'value' in remote
    ? remote.value
    : undefined
}

function parseStorage(result: unknown): {
  origin: string
  local: [string, string][]
  session: [string, string][]
} {
  const value = evaluatedValue(result)
  if (typeof value !== 'string')
    throw new CdpError('CDP_PROTOCOL', 'storage read returned no value')
  // The page can tamper with its own JSON/Storage globals, so malformed
  // output is a protocol failure, not an unhandled SyntaxError. The
  // SyntaxError is not passed on: V8 quotes the input, i.e. storage secrets.
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CdpError('CDP_PROTOCOL', 'storage read returned malformed JSON')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('origin' in parsed) ||
    typeof parsed.origin !== 'string' ||
    !('local' in parsed) ||
    !isStringPairs(parsed.local) ||
    !('session' in parsed) ||
    !isStringPairs(parsed.session)
  )
    throw new CdpError('CDP_PROTOCOL', 'storage read returned an unexpected shape')
  return { origin: parsed.origin, local: parsed.local, session: parsed.session }
}

function parseCookies(result: unknown): CdpCookie[] {
  const cookies =
    typeof result === 'object' && result !== null && 'cookies' in result
      ? result.cookies
      : undefined
  if (!Array.isArray(cookies)) throw new CdpError('CDP_PROTOCOL', 'cookie read returned no cookies')
  return cookies.flatMap((c: unknown) =>
    typeof c === 'object' &&
    c !== null &&
    'name' in c &&
    typeof c.name === 'string' &&
    'value' in c &&
    typeof c.value === 'string'
      ? [
          {
            name: c.name,
            value: c.value,
            ...('expires' in c && typeof c.expires === 'number' ? { expires: c.expires } : {}),
          },
        ]
      : [],
  )
}

/**
 * Reads the login tab: cookies that apply to `cookieUrls` (HttpOnly
 * included) and the tab's localStorage / sessionStorage. The tab must be on
 * `expectedOrigin` — storage read on another origin (an IdP page, say)
 * would capture the wrong site's values.
 */
export async function captureTab(
  targetId: string,
  expectedOrigin: string,
  cookieUrls: string[],
  opts: CdpOptions,
): Promise<CapturedTab> {
  if (!isTargetId(targetId)) throw new CdpError('TAB_NOT_FOUND', 'invalid capture tab id')
  const base = await resolveCdpBase(opts.baseUrl)
  const target = await findPageTarget(base, targetId, opts)
  // The advertised socket URL names Chrome's own loopback host; reach it the
  // same way as the HTTP endpoint.
  const wsUrl = new URL(target.webSocketDebuggerUrl ?? '')
  wsUrl.host = base.host
  return withSession(wsUrl.toString(), opts, async (send) => {
    const storage = parseStorage(
      await send('Runtime.evaluate', { expression: READ_STORAGE, returnByValue: true }),
    )
    if (storage.origin !== expectedOrigin)
      throw new CdpError(
        'WRONG_ORIGIN',
        `the login tab is on ${storage.origin}, not ${expectedOrigin} — finish logging in so the tab is back on the site, then capture`,
      )
    const cookies = parseCookies(await send('Network.getCookies', { urls: cookieUrls }))
    return {
      origin: storage.origin,
      cookies,
      localStorage: storage.local,
      sessionStorage: storage.session,
    }
  })
}
