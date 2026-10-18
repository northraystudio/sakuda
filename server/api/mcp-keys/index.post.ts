import { defineEventHandler, setResponseHeader, setResponseStatus } from 'h3'
import { mcpKeyDeps } from '../../lib/deps'
import { parseBody } from '../../lib/http'
import { logger } from '../../lib/logger'
import { issueMcpKey } from '../../services/mcpKeyService'
import { McpKeyInputSchema } from '#shared/schemas/mcpKey'
import type { IssuedMcpKey } from '#shared/types/api'

/** Issues an MCP API key (#20). The response is the only place the key ever
 * appears, so it is loopback-only (the `/api/**` guard, #22 — a
 * DNS-rebinding page must not mint one) and never cached. */
export default defineEventHandler(async (event): Promise<IssuedMcpKey> => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const input = await parseBody(event, McpKeyInputSchema)
  const issued = issueMcpKey(mcpKeyDeps(), input)
  logger.info({ operation: 'mcpKey.issue', mcpKeyId: issued.key.id }, 'MCP API key issued')
  setResponseStatus(event, 201)
  return issued
})
