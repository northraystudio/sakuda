import { defineEventHandler, getRequestHeader, setResponseStatus } from 'h3'
import { getEnv } from '../config/env'
import { isApiPath, isLoopbackRequest } from '../lib/loopback'

const FORBIDDEN_MESSAGE = 'loopback Host/Origin only'

/** DNS-rebinding guard for the whole HTTP API (#22): one check, before any
 * route runs, so a new route is covered without opting in. Pages and assets
 * are not guarded — they carry no data of their own and every read goes
 * through `/api/**`. `/mcp` keeps its own loopback-only check. */
export default defineEventHandler((event) => {
  if (!isApiPath(event.path)) return
  const host = getRequestHeader(event, 'host') ?? null
  const origin = getRequestHeader(event, 'origin') ?? null
  if (isLoopbackRequest(host, origin, getEnv().allowedHosts)) return
  // Same shape as Nitro's error JSON minus its `url`, which is built from the
  // received Host — the answer must never echo the rejected header values.
  setResponseStatus(event, 403, FORBIDDEN_MESSAGE)
  return {
    error: true,
    statusCode: 403,
    statusMessage: FORBIDDEN_MESSAGE,
    message: FORBIDDEN_MESSAGE,
  }
})
