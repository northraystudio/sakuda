import { createError, getRequestHeader, getRouterParam, readBody, type H3Event } from 'h3'
import type { z } from 'zod'
import { ServiceError } from '../services/errors'

/**
 * Accepts `application/json` and the `+json` structured-syntax suffix (e.g.
 * `application/vnd.api+json`), with or without a `; charset=...` parameter.
 */
function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return mime === 'application/json' || mime.endsWith('+json')
}

export async function parseBody<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  // Every route that calls this expects a JSON body. Rejecting anything else
  // (e.g. `text/plain`, which is exactly what a cross-origin
  // `<form enctype="text/plain">` "simple request" sends with no CORS
  // preflight) closes off a way to create sites / start scans from any page
  // an operator happens to visit while sakuda is reachable from their browser.
  if (!isJsonContentType(getRequestHeader(event, 'content-type')))
    throw createError({
      statusCode: 415,
      statusMessage: 'content-type must be application/json',
    })
  const r = schema.safeParse(await readBody(event))
  if (!r.success)
    throw createError({
      statusCode: 422,
      statusMessage: 'Validation failed',
      data: {
        code: 'VALIDATION',
        issues: r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
      },
    })
  return r.data
}

export function requireParam(event: H3Event, name: string): string {
  const v = getRouterParam(event, name)
  if (!v) throw createError({ statusCode: 400, statusMessage: `missing route param ${name}` })
  return v
}

export function toHttpError(err: unknown): never {
  if (err instanceof ServiceError)
    throw createError({
      statusCode: err.statusCode,
      statusMessage: err.message,
      data: { code: err.code, details: err.details },
    })
  throw err
}
