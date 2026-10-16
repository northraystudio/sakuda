import { createHash, randomBytes } from 'node:crypto'

/** Recognizable prefix so a leaked key can be spotted by secret scanners. */
const KEY_PREFIX = 'sakuda_'
const KEY_BYTES = 32

/** A fresh MCP API key (#20): 256 random bits, base64url. */
export function generateMcpKey(): string {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString('base64url')
}

/** What the DB stores instead of the key. A plain sha256 is enough: the key
 * is 256 random bits, so there is nothing to brute-force or look up in a
 * dictionary, and a fast hash keeps the per-request check cheap. */
export function hashMcpKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
