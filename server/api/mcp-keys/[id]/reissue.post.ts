import { defineEventHandler, setResponseHeader } from 'h3'
import { z } from 'zod'
import { mcpKeyDeps } from '../../../lib/deps'
import { parseBody, requireParam, toHttpError } from '../../../lib/http'
import { logger } from '../../../lib/logger'
import { reissueMcpKey } from '../../../services/mcpKeyService'
import type { IssuedMcpKey } from '#shared/types/api'

/** Replaces an MCP API key (#20); the old key is rejected from the next
 * request on. Loopback-only (the `/api/**` guard, #22) and never cached, like
 * issuing. */
export default defineEventHandler(async (event): Promise<IssuedMcpKey> => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const id = requireParam(event, 'id')
  await parseBody(event, z.object({}).strict())
  try {
    const issued = reissueMcpKey(mcpKeyDeps(), id)
    logger.info({ operation: 'mcpKey.reissue', mcpKeyId: id }, 'MCP API key reissued')
    return issued
  } catch (e) {
    toHttpError(e)
  }
})
