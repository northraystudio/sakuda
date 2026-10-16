import { beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { openDatabase, type Db } from '../../db/client'
import { mcpApiKeys } from '../../db/schema'
import { hashMcpKey } from '../../domain/mcpKey'
import { ServiceError } from '../errors'
import {
  issueMcpKey,
  listMcpKeys,
  mcpKeyLookup,
  reissueMcpKey,
  revokeMcpKey,
  type McpKeyServiceDeps,
} from '../mcpKeyService'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
let db: Db
let deps: McpKeyServiceDeps
let n = 0

beforeEach(() => {
  db = openDatabase({ file: ':memory:', migrationsFolder })
  n = 0
  deps = { db, now: () => new Date(Date.UTC(2026, 9, 16, 0, 0, n)), id: () => `key-${++n}` }
})

describe('mcpKeyService', () => {
  it('issues a key that validates, stores only its hash, and lists without it', () => {
    const { key, secret } = issueMcpKey(deps, { label: 'claude-code' })
    expect(secret).toMatch(/^sakuda_[A-Za-z0-9_-]{43}$/)
    const rows = db.select().from(mcpApiKeys).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.keyHash).toBe(hashMcpKey(secret))
    expect(JSON.stringify(rows)).not.toContain(secret)

    const listed = listMcpKeys(db)
    expect(listed).toEqual([key])
    expect(JSON.stringify(listed)).not.toContain(secret)
    expect(Object.keys(listed[0]!)).toEqual(['id', 'label', 'createdAt'])

    const lookup = mcpKeyLookup(db)
    expect(lookup.hasActiveKeys()).toBe(true)
    expect(lookup.isValidKey(secret)).toBe(true)
    expect(lookup.isValidKey(`${secret}x`)).toBe(false)
  })

  it('has no active keys on an empty store', () => {
    expect(mcpKeyLookup(db).hasActiveKeys()).toBe(false)
    expect(mcpKeyLookup(db).isValidKey('sakuda_anything')).toBe(false)
  })

  it('reissue rejects the old key at once and keeps the id and label', () => {
    const first = issueMcpKey(deps, { label: 'ci' })
    const second = reissueMcpKey(deps, first.key.id)
    const lookup = mcpKeyLookup(db)
    expect(second.key).toMatchObject({ id: first.key.id, label: 'ci' })
    expect(second.secret).not.toBe(first.secret)
    expect(lookup.isValidKey(first.secret)).toBe(false)
    expect(lookup.isValidKey(second.secret)).toBe(true)
  })

  it('revoke rejects only that key; the last revoke leaves no active keys', () => {
    const a = issueMcpKey(deps, { label: 'a' })
    const b = issueMcpKey(deps, { label: 'b' })
    const lookup = mcpKeyLookup(db)
    revokeMcpKey(db, a.key.id)
    expect(lookup.isValidKey(a.secret)).toBe(false)
    expect(lookup.isValidKey(b.secret)).toBe(true)
    revokeMcpKey(db, b.key.id)
    expect(lookup.hasActiveKeys()).toBe(false)
  })

  it('404s on reissue / revoke of an unknown id', () => {
    expect(() => reissueMcpKey(deps, 'nope')).toThrow(ServiceError)
    expect(() => revokeMcpKey(db, 'nope')).toThrow(
      expect.objectContaining({ statusCode: 404, code: 'MCP_KEY_NOT_FOUND' }),
    )
  })
})
