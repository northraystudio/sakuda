import { targetLineKey } from '#shared/utils/nucleiPaths'
import type { JsonFieldShape, RequestShape } from '#shared/types/api'
import type { ExpandedTarget } from '../../domain/nucleiTargets'
import type { FieldSpec, FieldType } from './cases'

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

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const REF_PREFIX = '#/components/schemas/'
const MAX_REF_DEPTH = 5

/** Follows a local `$ref` chain; null when it is external, missing or cyclic. */
function resolveSchema(root: Json, schema: unknown): Json | null {
  let current = schema
  for (let i = 0; i < MAX_REF_DEPTH; i++) {
    if (!isObject(current)) return null
    const ref = current.$ref
    if (typeof ref !== 'string') return current
    if (!ref.startsWith(REF_PREFIX)) return null
    const schemas = isObject(root.components) ? root.components.schemas : undefined
    current = isObject(schemas) ? schemas[ref.slice(REF_PREFIX.length)] : undefined
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

/** A value for a `{param}` in a path: the schema's example, else 1 / "1". */
function pathParamValue(root: Json, operation: Json, pathItem: Json, name: string): string {
  const params = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ]
  for (const p of params) {
    if (!isObject(p) || p.name !== name || p.in !== 'path') continue
    if (p.example !== undefined) return String(p.example)
    const schema = resolveSchema(root, p.schema)
    if (schema?.example !== undefined) return String(schema.example)
  }
  return '1'
}

/**
 * The JSON-body write operations of a pasted OpenAPI 3 document. Only
 * `application/json` request bodies whose schema is an object are used; the
 * document's `servers` are ignored — the caller supplies the base URL, so
 * nothing outside the saved origins is ever addressed. A document that is not
 * parseable yields no operations (the caller warns).
 */
export function operationsFromOpenApi(
  openapiJson: string,
  baseUrl: string,
  isExcludedPath: (pathname: string) => boolean,
): BoundaryOperation[] {
  let root: unknown
  try {
    root = JSON.parse(openapiJson)
  } catch {
    return []
  }
  if (!isObject(root) || !isObject(root.paths)) return []
  const ops: BoundaryOperation[] = []
  for (const [path, item] of Object.entries(root.paths)) {
    if (!isObject(item)) continue
    for (const method of WRITE_METHODS) {
      const operation = item[method.toLowerCase()]
      if (!isObject(operation)) continue
      const requestBody = resolveRequestBody(root, operation.requestBody)
      if (!requestBody) continue
      const content = requestBody.content
      const media = isObject(content) ? content['application/json'] : undefined
      const schema = isObject(media) ? resolveSchema(root, media.schema) : null
      const parsed = schema ? fieldsFromObjectSchema(root, schema) : null
      if (!parsed || parsed.fields.length === 0) continue
      const filled = path.replace(/\{([^}]+)\}/g, (_, name: string) =>
        encodeURIComponent(pathParamValue(root, operation, item, name)),
      )
      const url = `${baseUrl.replace(/\/+$/, '')}/${filled.replace(/^\/+/, '')}`
      if (!URL.canParse(url) || isExcludedPath(new URL(url).pathname)) continue
      ops.push({ method, url, fields: parsed.fields, skippedFields: parsed.skipped })
    }
  }
  return ops
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
