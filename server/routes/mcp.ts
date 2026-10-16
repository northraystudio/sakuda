import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import {
  defineEventHandler,
  getRequestHeader,
  setResponseHeader,
  setResponseStatus,
  toWebRequest,
} from 'h3'
import { getEnv } from '../config/env'
import { timeBudgetEnv } from '../domain/engineTimeBudget'
import { getDb } from '../db/client'
import { siteDeps } from '../lib/deps'
import { logger } from '../lib/logger'
import { checkMcpRequest } from '../mcp/auth'
import { createSakudaMcpServer } from '../mcp/tools'
import { mcpKeyLookup } from '../services/mcpKeyService'

/**
 * MCP endpoint (#16 read, #18 write), Streamable HTTP in stateless mode: a
 * fresh server and transport per request, JSON responses instead of SSE. The
 * tools go through the same services (and so the same validation and scan
 * gates) as the REST API.
 */
export default defineEventHandler(async (event) => {
  // A `reveal: true` response carries real secrets — never let it be cached.
  setResponseHeader(event, 'cache-control', 'no-store')
  const env = getEnv()
  const auth = checkMcpRequest(
    {
      host: getRequestHeader(event, 'host') ?? null,
      origin: getRequestHeader(event, 'origin') ?? null,
      authorization: getRequestHeader(event, 'authorization') ?? null,
    },
    mcpKeyLookup(getDb()),
  )
  if (!auth.ok) {
    logger.warn({ operation: 'mcp.request', status: auth.status }, auth.message)
    setResponseStatus(event, auth.status)
    if (auth.status === 401) setResponseHeader(event, 'www-authenticate', 'Bearer')
    return { error: auth.message }
  }

  const server = createSakudaMcpServer(
    { site: siteDeps(), timeBudgetEnv: timeBudgetEnv(env) },
    { authenticated: auth.authenticated },
  )
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(toWebRequest(event))
  } finally {
    await server.close()
  }
})
