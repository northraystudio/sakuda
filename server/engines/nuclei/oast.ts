import { rm } from 'node:fs/promises'
import type { Header } from '#shared/schemas/headers'
import type { OastConfig } from '../../config/env'
import { headerLines } from '../headersConfig'
import { writeSecretFile } from '../secretFile'

/**
 * nuclei's built-in interactsh servers (`-iserver` default in v3.11.1).
 * With `SAKUDA_OAST=public` nuclei picks from this list itself; sakuda only
 * needs it to say where callbacks go and to probe reachability.
 */
export const NUCLEI_PUBLIC_OAST_SERVERS = [
  'oast.pro',
  'oast.live',
  'oast.site',
  'oast.online',
  'oast.fun',
  'oast.me',
]

const PROBE_TIMEOUT_MS = 5_000

/** What `meta.oast.status` reports: `used` = configured and reachable,
 * `disabled` = `SAKUDA_OAST=off`, `unavailable` = the probe got no answer. */
export type OastStatus = 'used' | 'disabled' | 'unavailable'

/** nuclei argv for the OAST setting. `-ni` also makes nuclei exclude every
 * OAST template, so with `off` no interactsh traffic leaves the scan. The
 * token never goes here — see {@link withNucleiConfig}. */
export function oastArgs(oast: OastConfig): string[] {
  switch (oast.mode) {
    case 'public':
      return []
    case 'off':
      return ['-ni']
    case 'self-hosted':
      return ['-iserver', oast.serverUrl]
    default: {
      const unreachable: never = oast
      return unreachable
    }
  }
}

/** Where callbacks go, for `meta` and logs; null when OAST is off. */
export function oastServerLabel(oast: OastConfig): string | null {
  if (oast.mode === 'off') return null
  if (oast.mode === 'public') return NUCLEI_PUBLIC_OAST_SERVERS.join(',')
  return oast.serverUrl
}

export type OastProbeResult = { reachable: true } | { reachable: false; reason: string }

/**
 * One GET to the interactsh server(s) before nuclei runs. nuclei logs a
 * failed interactsh registration only at `-v` level, so without this an
 * unreachable server just looks like "no out-of-band findings" (#35). Any
 * HTTP answer counts — interactsh answers `/` with a banner or a 404; only a
 * network failure or the timeout does not. A wrong token is not caught here.
 * With `off` nothing is sent.
 */
export async function probeOastServer(
  oast: OastConfig,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OastProbeResult> {
  if (oast.mode === 'off') return { reachable: true }
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  const urls =
    oast.mode === 'public'
      ? NUCLEI_PUBLIC_OAST_SERVERS.map((h) => `https://${h}/`)
      : [`${oast.serverUrl}/`]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await Promise.any(
      urls.map((u) =>
        fetchImpl(u, { method: 'GET', redirect: 'manual', signal: controller.signal }),
      ),
    )
    return { reachable: true }
  } catch (err) {
    if (controller.signal.aborted)
      return { reachable: false, reason: `no answer within ${timeoutMs} ms` }
    const causes = err instanceof AggregateError ? err.errors : [err]
    const reason = [...new Set(causes.map(describeFetchError))].join('; ')
    return { reachable: false, reason }
  } finally {
    clearTimeout(timer)
    // Stop the requests still in flight once one server has answered.
    controller.abort()
  }
}

/** Node's fetch hides the network error under `cause`; that is what names
 * DNS / refused / TLS failures. */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : ''
  return `${err.message}${cause}`
}

/**
 * Runs `fn` with the `-config` file nuclei should read. A self-hosted token
 * goes in a nuclei-only 0600 file (`interactsh-token`, plus the site's
 * headers, since nuclei takes one `-config`), removed when the run ends —
 * never on argv. httpx keeps the shared headers file, which has no token.
 * With no token, nuclei reads the shared headers file (or nothing).
 */
export async function withNucleiConfig<T>(
  path: string,
  headers: Header[],
  oast: OastConfig,
  headersConfigFile: string | null,
  fn: (nucleiConfigFile: string | null) => Promise<T>,
): Promise<T> {
  if (oast.mode !== 'self-hosted' || oast.token === undefined) return fn(headersConfigFile)
  const config = {
    ...(headers.length > 0 ? { header: headerLines(headers) } : {}),
    'interactsh-token': oast.token,
  }
  await writeSecretFile(path, JSON.stringify(config))
  try {
    return await fn(path)
  } finally {
    await rm(path, { force: true })
  }
}
