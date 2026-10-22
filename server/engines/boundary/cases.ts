/** The value types a boundary probe can reason about. Containers (object /
 * array) are not probed: one field at a time means one scalar at a time. */
export type FieldType = 'string' | 'integer' | 'number' | 'boolean'

/** What the API contract says about one top-level body field. Everything but
 * `name`/`type`/`required` is optional — a field seen only as a captured shape
 * carries no range at all, and then only type and emptiness can be probed. */
export interface FieldSpec {
  name: string
  type: FieldType
  required: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  enum?: unknown[]
  format?: string
  /** The contract's own example/default, preferred for the "valid" baseline. */
  example?: unknown
}

export type CaseKind =
  | 'below-minimum'
  | 'above-maximum'
  | 'too-short'
  | 'too-long'
  | 'not-in-enum'
  | 'wrong-type'
  | 'empty'

export interface BoundaryCase {
  field: string
  kind: CaseKind
  /** The one out-of-contract value sent for `field`. */
  sent: unknown
  /** The whole request body: every other field valid, `field` = `sent`. */
  body: Record<string, unknown>
  /** Human-readable statement of what rule was violated. */
  detail: string
}

/** A `maxLength + 1` string longer than this is not sent: the contract is
 * effectively unbounded and the probe would only be a large upload. */
export const MAX_PROBE_LENGTH = 10_000

const FORMAT_EXAMPLES: Record<string, string> = {
  email: 'sakuda@example.com',
  uri: 'https://example.com/',
  url: 'https://example.com/',
  uuid: '00000000-0000-4000-8000-000000000000',
  date: '2020-01-01',
  'date-time': '2020-01-01T00:00:00Z',
}

const NOT_IN_ENUM = 'sakuda-not-in-enum'

/** A value that satisfies the contract — the filler for every field a case is
 * not about, so a rejection can only be blamed on the field under test. */
export function validValue(f: FieldSpec): unknown {
  if (f.example !== undefined) return f.example
  if (f.enum && f.enum.length > 0) return f.enum[0]
  switch (f.type) {
    case 'boolean':
      return true
    case 'integer':
    case 'number': {
      let v = f.minimum ?? 1
      if (f.maximum !== undefined && v > f.maximum) v = f.maximum
      return f.type === 'integer' ? Math.ceil(v) : v
    }
    case 'string': {
      let s = (f.format && FORMAT_EXAMPLES[f.format]) || 'test'
      if (f.minLength !== undefined && s.length < f.minLength) s = s.padEnd(f.minLength, 'x')
      if (f.maxLength !== undefined && s.length > f.maxLength) s = s.slice(0, f.maxLength)
      return s
    }
  }
}

function wrongTypeValue(type: FieldType): unknown {
  switch (type) {
    case 'string':
      return 12345
    case 'boolean':
      return 'sakuda-not-a-boolean'
    default:
      return 'sakuda-not-a-number'
  }
}

/** Out-of-contract values for one field, each paired with the rule it breaks.
 * Only rules the contract actually states are probed (no `maximum` → no
 * above-maximum case); type confusion and, for required strings, emptiness
 * need no stated rule. */
function fieldCases(f: FieldSpec): Array<Pick<BoundaryCase, 'kind' | 'sent' | 'detail'>> {
  const out: Array<Pick<BoundaryCase, 'kind' | 'sent' | 'detail'>> = []
  const numeric = f.type === 'integer' || f.type === 'number'
  if (numeric && f.minimum !== undefined)
    out.push({
      kind: 'below-minimum',
      sent: f.minimum - 1,
      detail: `below the minimum of ${f.minimum}`,
    })
  if (numeric && f.maximum !== undefined)
    out.push({
      kind: 'above-maximum',
      sent: f.maximum + 1,
      detail: `above the maximum of ${f.maximum}`,
    })
  if (f.type === 'string' && f.minLength !== undefined && f.minLength > 0)
    out.push({
      kind: 'too-short',
      sent: 'x'.repeat(f.minLength - 1),
      detail: `shorter than the minimum length of ${f.minLength}`,
    })
  if (f.type === 'string' && f.maxLength !== undefined && f.maxLength + 1 <= MAX_PROBE_LENGTH)
    out.push({
      kind: 'too-long',
      sent: 'x'.repeat(f.maxLength + 1),
      detail: `longer than the maximum length of ${f.maxLength}`,
    })
  if (f.enum && f.enum.length > 0) {
    const numbers = f.enum.filter((v): v is number => typeof v === 'number')
    const sent = numeric ? (numbers.length > 0 ? Math.max(...numbers) + 1 : undefined) : NOT_IN_ENUM
    if (sent !== undefined)
      out.push({
        kind: 'not-in-enum',
        sent,
        detail: `outside the allowed values (${f.enum.map(String).join(', ')})`,
      })
  } else {
    out.push({
      kind: 'wrong-type',
      sent: wrongTypeValue(f.type),
      detail: `a ${typeof wrongTypeValue(f.type)} where a ${f.type} is declared`,
    })
  }
  if (f.type === 'string' && f.required && !(f.minLength !== undefined && f.minLength > 0))
    out.push({ kind: 'empty', sent: '', detail: 'an empty value for a required field' })
  return out
}

/**
 * The boundary requests to try for one operation: one case per violated
 * rule per field, every other field held at a valid value. Pure — it decides
 * *what* to send; `acceptance` decides whether the server's reaction counts.
 */
export function boundaryCases(fields: FieldSpec[]): BoundaryCase[] {
  const baseline: Record<string, unknown> = {}
  for (const f of fields) baseline[f.name] = validValue(f)
  return fields.flatMap((f) =>
    fieldCases(f).map((c) => ({
      field: f.name,
      kind: c.kind,
      sent: c.sent,
      body: { ...baseline, [f.name]: c.sent },
      detail: c.detail,
    })),
  )
}
