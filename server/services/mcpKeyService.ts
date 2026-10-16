import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { mcpApiKeys, type McpApiKeyRow } from '../db/schema'
import { generateMcpKey, hashMcpKey } from '../domain/mcpKey'
import { ServiceError } from './errors'
import type { McpKeyInput } from '#shared/schemas/mcpKey'
import type { IssuedMcpKey, McpKeyView } from '#shared/types/api'

export interface McpKeyServiceDeps {
  db: Db
  now: () => Date
  id: () => string
}

function toView(row: McpApiKeyRow): McpKeyView {
  return { id: row.id, label: row.label, createdAt: row.createdAt }
}

export function listMcpKeys(db: Db): McpKeyView[] {
  return db.select().from(mcpApiKeys).orderBy(asc(mcpApiKeys.createdAt)).all().map(toView)
}

export function issueMcpKey(deps: McpKeyServiceDeps, input: McpKeyInput): IssuedMcpKey {
  const secret = generateMcpKey()
  const row = {
    id: deps.id(),
    label: input.label,
    keyHash: hashMcpKey(secret),
    createdAt: deps.now().toISOString(),
  }
  deps.db.insert(mcpApiKeys).values(row).run()
  return { key: toView(row), secret }
}

/** Replaces the key in place: the old one stops working on the very next
 * request, the label and id stay so the list still reads the same. */
export function reissueMcpKey(deps: McpKeyServiceDeps, id: string): IssuedMcpKey {
  const secret = generateMcpKey()
  const row = deps.db
    .update(mcpApiKeys)
    .set({ keyHash: hashMcpKey(secret), createdAt: deps.now().toISOString() })
    .where(eq(mcpApiKeys.id, id))
    .returning()
    .get()
  if (!row) throw new ServiceError(404, 'MCP_KEY_NOT_FOUND', `MCP API key ${id} not found`)
  return { key: toView(row), secret }
}

export function revokeMcpKey(db: Db, id: string): void {
  const r = db.delete(mcpApiKeys).where(eq(mcpApiKeys.id, id)).run()
  if (r.changes === 0)
    throw new ServiceError(404, 'MCP_KEY_NOT_FOUND', `MCP API key ${id} not found`)
}

/** What `checkMcpRequest` needs from the store, read on every request so
 * issuing, reissuing and revoking take effect without a restart. */
export interface McpKeyLookup {
  hasActiveKeys: () => boolean
  isValidKey: (key: string) => boolean
}

export function mcpKeyLookup(db: Db): McpKeyLookup {
  return {
    hasActiveKeys: () =>
      db.select({ id: mcpApiKeys.id }).from(mcpApiKeys).limit(1).get() !== undefined,
    // Looked up by hash, so the plaintext is never compared or stored; the
    // indexed equality leaks nothing useful about a 256-bit preimage.
    isValidKey: (key) =>
      db
        .select({ id: mcpApiKeys.id })
        .from(mcpApiKeys)
        .where(eq(mcpApiKeys.keyHash, hashMcpKey(key)))
        .get() !== undefined,
  }
}
