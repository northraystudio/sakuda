import { isLoopbackRequest } from '../lib/loopback'
import type { McpKeyLookup } from '../services/mcpKeyService'

export type McpAuth =
  { ok: true; authenticated: boolean } | { ok: false; status: 401 | 403; message: string }

/**
 * With no key issued, MCP stays an unauthenticated loopback tool like the
 * rest of the API, and `authenticated` is false — so secrets are never
 * revealed. Once at least one key is issued (#20), every request must carry
 * `Authorization: Bearer <key>` matching one of them. The lookup is read per
 * request, so a reissued or revoked key stops working immediately.
 */
export function checkMcpRequest(
  headers: { host: string | null; origin: string | null; authorization: string | null },
  keys: McpKeyLookup,
): McpAuth {
  if (!isLoopbackRequest(headers.host, headers.origin))
    return { ok: false, status: 403, message: 'MCP accepts loopback Host/Origin only' }
  if (!keys.hasActiveKeys()) return { ok: true, authenticated: false }

  const match = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')
  const token = match?.[1]?.trim()
  if (!token || !keys.isValidKey(token))
    return { ok: false, status: 401, message: 'missing or invalid MCP API key' }
  return { ok: true, authenticated: true }
}
