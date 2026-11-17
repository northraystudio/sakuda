import { targetLineKey } from '#shared/utils/nucleiPaths'
import type { JsonFieldShape, RequestShape } from '#shared/types/api'
import type { ExpandedTarget } from '../../domain/nucleiTargets'
import { FORMAT_EXAMPLES, type FieldSpec, type FieldType } from './cases'

export type WriteMethod = 'POST' | 'PUT' | 'PATCH'
const WRITE_METHODS: readonly WriteMethod[] = ['POST', 'PUT', 'PATCH']

/** One write endpoint to probe: where to send, and the body fields it takes. */
export interface BoundaryOperation {
  method: WriteMethod
  /** Absolute URL on a saved origin (path parameters already filled). */
  url: string
  fields: FieldSpec[]
  /** Body fields skipped because they are containers or an unknown type. */
  skippedFields: number
}

/** Why a write operation in the OpenAPI document was not turned into a probe. */
export type SkipReason =
  'no-json-body' | 'unsupported-schema' | 'no-testable-fields' | 'excluded-path' | 'invalid-url'

/** A write operation of the document that boundary did not test, and why. */
export interface SkippedOperation {
  method: WriteMethod
  /** The path as the document writes it (`/users/{id}`), not a filled URL. */
  path: string
  reason: SkipReason
}

export interface OpenApiOperations {
  operations: BoundaryOperation[]
  skipped: SkippedOperation[]
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const REF_PREFIX = '#/components/schemas/'
const MAX_RESOLVE_DEPTH = 5

/**
 * The one non-null member of an `anyOf`/`oneOf` that also allows `null` — how
 * FastAPI writes `Optional[T]`. Undefined for any other schema, including a
 * union of two real types (boundary cannot tell which one to probe).
 */
function nonNullMember(schema: Json): unknown {
  const union = schema.anyOf ?? schema.oneOf
  if (!Array.isArray(union)) return undefined
  const rest = union.filter((m) => !(isObject(m) && m.type === 'null'))
  return rest.length === 1 && rest.length < union.length ? rest[0] : undefined
}

/**
 * The schema a field or body really is: follows local `$ref`s and unwraps
 * `Optional` (see `nonNullMember`). This is the single place where spelling
 * differences in the document are absorbed. What the wrapper states beside the
 * union (`default`, `example`) is kept unless the inner schema says otherwise.
 * Null when a `$ref` is external, missing or cyclic.
 */
function resolveSchema(root: Json, schema: unknown): Json | null {
  let current = schema
  let inherited: Json = {}
  for (let i = 0; i < MAX_RESOLVE_DEPTH; i++) {
    if (!isObject(current)) return null
    const ref = current.$ref
    if (typeof ref === 'string') {
      if (!ref.startsWith(REF_PREFIX)) return null
      const schemas = isObject(root.components) ? root.components.schemas : undefined
      current = isObject(schemas) ? schemas[ref.slice(REF_PREFIX.length)] : undefined
      continue
    }
    const member = nonNullMember(current)
    if (member === undefined) return { ...inherited, ...current }
    const beside = Object.entries(current).filter(([k]) => k !== 'anyOf' && k !== 'oneOf')
    inherited = { ...inherited, ...Object.fromEntries(beside) }
    current = member
  }
  return null
}

const REQUEST_BODY_REF_PREFIX = '#/components/requestBodies/'

/** A `requestBody`, following one local `$ref` to `components.requestBodies`; null otherwise. */
function resolveRequestBody(root: Json, body: unknown): Json | null {
  if (!isObject(body)) return null
  const ref = body.$ref
  if (typeof ref !== 'string') return body
  if (!ref.startsWith(REQUEST_BODY_REF_PREFIX)) return null
  const bodies = isObject(root.components) ? root.components.requestBodies : undefined
  const resolved = isObject(bodies) ? bodies[ref.slice(REQUEST_BODY_REF_PREFIX.length)] : undefined
  return isObject(resolved) && typeof resolved.$ref !== 'string' ? resolved : null
}

function fieldFromSchema(name: string, schema: Json, required: boolean): FieldSpec | null {
  const type = schema.type
  if (type !== 'string' && type !== 'integer' && type !== 'number' && type !== 'boolean')
    return null
  const num = (k: string): number | undefined =>
    typeof schema[k] === 'number' ? (schema[k] as number) : undefined
  return {
    name,
    type,
    required,
    minimum: num('minimum'),
    maximum: num('maximum'),
    minLength: num('minLength'),
    maxLength: num('maxLength'),
    enum: Array.isArray(schema.enum) ? schema.enum : undefined,
    format: typeof schema.format === 'string' ? schema.format : undefined,
    example: schema.example ?? schema.default,
  }
}

function fieldsFromObjectSchema(
  root: Json,
  schema: Json,
): { fields: FieldSpec[]; skipped: number } | null {
  if (!isObject(schema.properties)) return null
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [],
  )
  const fields: FieldSpec[] = []
  let skipped = 0
  for (const [name, raw] of Object.entries(schema.properties)) {
    const resolved = resolveSchema(root, raw)
    const field = resolved ? fieldFromSchema(name, resolved, required.has(name)) : null
    if (field) fields.push(field)
    else skipped++
  }
  return { fields, skipped }
}

const segments = (pathname: string): string[] => pathname.split('/').filter(Boolean)
const isParamSegment = (segment: string): boolean => /^\{[^}]+\}$/.test(segment)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether a segment of a saved URL can stand in for this path parameter — so
 * `/users/me` is not mistaken for a numeric or UUID id. */
function fitsParam(value: string, schema: Json | null): boolean {
  if (schema?.format === 'uuid') return UUID.test(value)
  if (schema?.type === 'integer') return /^\d+$/.test(value)
  return true
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null // malformed percent-encoding: not usable as an id
  }
}

/** The path segments of every saved URL on `baseUrl`'s origin. */
function savedPathsOn(baseUrl: string, savedUrls: readonly string[]): string[][] {
  if (!URL.canParse(baseUrl)) return []
  const origin = new URL(baseUrl).origin
  const out: string[][] = []
  for (const saved of savedUrls) {
    if (!URL.canParse(saved) || new URL(saved).origin !== origin) continue
    const decoded = segments(new URL(saved).pathname).map(decodeSegment)
    if (decoded.every((d): d is string => d !== null)) out.push(decoded)
  }
  return out
}

/** A real id for the parameter at `index`: the same position of the first
 * saved URL whose path agrees with the template up to there. */
function savedPathValue(
  template: string[],
  index: number,
  savedPaths: string[][],
  schema: Json | null,
): string | undefined {
  for (const saved of savedPaths) {
    const candidate = saved[index]
    if (candidate === undefined || !fitsParam(candidate, schema)) continue
    const agrees = template.slice(0, index).every((t, i) => isParamSegment(t) || t === saved[i])
    if (agrees) return candidate
  }
  return undefined
}

/** The declaration of a `{param}`; the operation's own wins over the path item's. */
function pathParam(operation: Json, pathItem: Json, name: string): Json | undefined {
  const params = [
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
  ]
  return params.find((p): p is Json => isObject(p) && p.name === name && p.in === 'path')
}

/**
 * A value for a `{param}` in a path, in order: the document's example, a real
 * id from a saved URL, a fixed placeholder in the declared `format`, else "1".
 * The placeholder is fixed (never random) so two scans stay comparable.
 */
function pathParamValue(
  root: Json,
  param: Json | undefined,
  savedValue: (schema: Json | null) => string | undefined,
): string {
  if (param?.example !== undefined) return String(param.example)
  const schema = param ? resolveSchema(root, param.schema) : null
  if (schema?.example !== undefined) return String(schema.example)
  const format = typeof schema?.format === 'string' ? schema.format : undefined
  return savedValue(schema) ?? (format ? FORMAT_EXAMPLES[format] : undefined) ?? '1'
}

/**
 * The JSON-body write operations of a pasted OpenAPI 3 document, and the write
 * operations it could not use (with the reason — never dropped silently). Only
 * `application/json` request bodies whose schema is an object are used; the
 * document's `servers` are ignored — the caller supplies the base URL, so
 * nothing outside the saved origins is ever addressed. `savedUrls` are the
 * site's saved target URLs, read only to fill path parameters with real ids.
 * A document that is not parseable yields nothing (the caller warns).
 */
export function operationsFromOpenApi(
  openapiJson: string,
  baseUrl: string,
  isExcludedPath: (pathname: string) => boolean,
  savedUrls: readonly string[] = [],
): OpenApiOperations {
  const operations: BoundaryOperation[] = []
  const skipped: SkippedOperation[] = []
  let root: unknown
  try {
    root = JSON.parse(openapiJson)
  } catch {
    return { operations, skipped }
  }
  if (!isObject(root) || !isObject(root.paths)) return { operations, skipped }
  const base = baseUrl.replace(/\/+$/, '')
  const basePath = URL.canParse(base) ? segments(new URL(base).pathname) : []
  const savedPaths = savedPathsOn(baseUrl, savedUrls)
  for (const [path, item] of Object.entries(root.paths)) {
    if (!isObject(item)) continue
    const template = [...basePath, ...segments(path)]
    for (const method of WRITE_METHODS) {
      const operation = item[method.toLowerCase()]
      if (!isObject(operation)) continue
      const skip = (reason: SkipReason) => skipped.push({ method, path, reason })
      if (operation.requestBody === undefined) {
        skip('no-json-body')
        continue
      }
      const requestBody = resolveRequestBody(root, operation.requestBody)
      if (!requestBody) {
        skip('unsupported-schema')
        continue
      }
      const content = requestBody.content
      const media = isObject(content) ? content['application/json'] : undefined
      if (!isObject(media)) {
        skip('no-json-body')
        continue
      }
      const schema = resolveSchema(root, media.schema)
      const parsed = schema ? fieldsFromObjectSchema(root, schema) : null
      if (!parsed) {
        skip('unsupported-schema')
        continue
      }
      if (parsed.fields.length === 0) {
        skip('no-testable-fields')
        continue
      }
      const filled = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
        const index = template.indexOf(`{${name}}`)
        return encodeURIComponent(
          pathParamValue(root, pathParam(operation, item, name), (paramSchema) =>
            index < 0 ? undefined : savedPathValue(template, index, savedPaths, paramSchema),
          ),
        )
      })
      const url = `${base}/${filled.replace(/^\/+/, '')}`
      if (!URL.canParse(url)) {
        skip('invalid-url')
        continue
      }
      if (isExcludedPath(new URL(url).pathname)) {
        skip('excluded-path')
        continue
      }
      operations.push({ method, url, fields: parsed.fields, skippedFields: parsed.skipped })
    }
  }
  return { operations, skipped }
}

function shapeType(shape: JsonFieldShape): FieldType | null {
  switch (shape.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return shape.type
    default:
      return null
  }
}

/**
 * The JSON-body write operations of the site's approved POST/PUT/PATCH lines
 * whose request shape was captured. A shape holds names and JSON types only —
 * no ranges, and not whether a field is required — so these operations are
 * probed for type confusion only: an empty value is a legitimate input for an
 * optional field, and sending one would turn a correct server into a finding.
 */
export function operationsFromShapes(
  targets: ExpandedTarget[],
  requestShapes: Record<string, RequestShape>,
): BoundaryOperation[] {
  const ops: BoundaryOperation[] = []
  for (const t of targets) {
    if (!(WRITE_METHODS as readonly string[]).includes(t.method)) continue
    const shape = requestShapes[targetLineKey(t)]?.bodyShape
    if (shape?.kind !== 'json' || shape.root.type !== 'object' || !shape.root.fields) continue
    const fields: FieldSpec[] = []
    let skipped = 0
    for (const [name, fieldShape] of Object.entries(shape.root.fields)) {
      const type = shapeType(fieldShape)
      if (type) fields.push({ name, type, required: false })
      else skipped++
    }
    if (fields.length > 0)
      ops.push({ method: t.method as WriteMethod, url: t.url, fields, skippedFields: skipped })
  }
  return ops
}
