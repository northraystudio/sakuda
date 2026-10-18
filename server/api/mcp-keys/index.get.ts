import { defineEventHandler } from 'h3'
import { getDb } from '../../db/client'
import { listMcpKeys } from '../../services/mcpKeyService'
import type { McpKeyView } from '#shared/types/api'

/** Issued MCP API keys (#20) — labels and dates only, never the keys. */
export default defineEventHandler((): McpKeyView[] => {
  return listMcpKeys(getDb())
})
