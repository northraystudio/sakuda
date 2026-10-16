import type { BrowserStorageItem } from '#shared/schemas/browserStorage'
import type { Header } from '#shared/schemas/headers'

/** A secret value and the label its placeholder carries, so an agent can tell
 * *which* configured value was hidden (e.g. `[SECRET:header:Authorization]`)
 * and substitute its own copy instead of guessing. */
export interface SecretValue {
  label: string
  value: string
}

/** Values shorter than this are not replaced: a 1–5 character "secret" would
 * also match ordinary text and shred the evidence it is meant to protect. */
export const MIN_SECRET_LENGTH = 6

export const EVIDENCE_MAX_CHARS = 2000

/** Every form in which a configured secret can come back from the target:
 * the whole header value, the credential after an auth scheme
 * (`Bearer <token>`), and each value inside a `Cookie` header. */
export function collectSecrets(headers: Header[], storage: BrowserStorageItem[]): SecretValue[] {
  const secrets: SecretValue[] = []
  for (const h of headers) {
    const label = `header:${h.name}`
    secrets.push({ label, value: h.value })
    const lower = h.name.toLowerCase()
    if (lower === 'authorization' || lower === 'proxy-authorization') {
      const credential = h.value.split(/\s+/).slice(1).join(' ')
      if (credential) secrets.push({ label, value: credential })
    }
    if (lower === 'cookie') {
      for (const pair of h.value.split(';')) {
        const eq = pair.indexOf('=')
        if (eq < 0) continue
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        if (value) secrets.push({ label: `cookie:${name}`, value })
      }
    }
  }
  for (const item of storage) {
    secrets.push({ label: `storage:${item.kind}:${item.name}`, value: item.value })
  }
  return secrets
    .filter((s) => s.value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.value.length - a.value.length)
}

/** Replaces each secret value with its labeled placeholder. Longest values go
 * first so a header that contains a shorter secret is hidden as a whole. */
export function redactText(text: string, secrets: SecretValue[]): string {
  let out = text
  for (const s of secrets) out = out.split(s.value).join(`[SECRET:${s.label}]`)
  return out
}

/** Applies `redactText` to every string in a JSON-like value. Redacting the
 * whole response, not chosen fields, means a secret reflected into a URL,
 * a warning or an engine's meta is hidden too. */
export function redactDeep<T>(value: T, secrets: SecretValue[]): T {
  if (secrets.length === 0) return value
  return walk(value, secrets) as T
}

function walk(value: unknown, secrets: SecretValue[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((v) => walk(v, secrets))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, secrets)]))
  return value
}

/** Evidence is whatever the scanned server sent back, so it is handed to the
 * agent marked as untrusted data and cut to a bounded length. */
export interface UntrustedText {
  untrusted: true
  source: 'target-response'
  text: string
  truncated: boolean
}

export function wrapUntrusted(text: string, limit = EVIDENCE_MAX_CHARS): UntrustedText {
  const truncated = text.length > limit
  return {
    untrusted: true,
    source: 'target-response',
    text: truncated ? text.slice(0, limit) : text,
    truncated,
  }
}
