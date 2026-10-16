import { defineEventHandler, setResponseStatus } from 'h3'
import { getDb } from '../../db/client'
import { requireLoopbackRequest, requireParam, toHttpError } from '../../lib/http'
import { logger } from '../../lib/logger'
import { revokeMcpKey } from '../../services/mcpKeyService'

/** Revokes an MCP API key (#20); it is rejected from the next request on. */
export default defineEventHandler((event) => {
  requireLoopbackRequest(event)
  const id = requireParam(event, 'id')
  try {
    revokeMcpKey(getDb(), id)
    logger.info({ operation: 'mcpKey.revoke', mcpKeyId: id }, 'MCP API key revoked')
    setResponseStatus(event, 204)
    return null
  } catch (e) {
    toHttpError(e)
  }
})
