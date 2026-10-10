import type { RequestShape, SitePublic } from '../../shared/types/api.ts'
import type { TargetShape } from '../../shared/schemas/targets.ts'

/** The origin `targets/juice-shop/site.json` is written against — what
 * `make juice-up` publishes with the default `JUICESHOP_PORT`. */
export const DEFAULT_JUICE_ORIGIN = 'http://127.0.0.1:4001'

/** What `targets/juice-shop/site.json` holds: a site as `GET /api/sites/:id`
 * returns it, minus the per-instance parts (id, timestamps, header / storage
 * names, confirmation flag). No secret ever lives in it — the JWT is fetched
 * per run. */
export type SiteTemplate = Omit<
  SitePublic,
  'id' | 'createdAt' | 'updatedAt' | 'headerNames' | 'browserStorageNames' | 'requiresConfirmation'
>

/** The fields `POST /api/sites` and `PUT /api/sites/:id` accept, read off a
 * template (create) or a stored site (update). One list, so create and update
 * can never drift apart. */
const SITE_FIELD_KEYS = [
  'name',
  'frontBaseUrl',
  'apiBaseUrl',
  'nucleiPaths',
  'openapiUrl',
  'openapiJson',
  'zapFeSeedPath',
  'discoverySeedPaths',
  'crawlScopePaths',
  'excludePaths',
  'nucleiRateLimit',
  'nucleiMaxMinutes',
  'nucleiConcurrency',
  'zapApiMaxMinutes',
  'zapFeSpiderMaxMinutes',
  'nonLocalConfirmed',
  'allowMutatingRequests',
  'nucleiEnabledRiskTags',
] as const satisfies readonly (keyof SiteTemplate)[]

type SiteFields = Pick<SiteTemplate, (typeof SITE_FIELD_KEYS)[number]>

function siteFields(source: SiteFields): SiteFields {
  return Object.fromEntries(SITE_FIELD_KEYS.map((k) => [k, source[k]])) as SiteFields
}

export interface SeedCredentials {
  email: string
  password: string
  securityAnswer: string
}

export interface SeedJuiceShopInput {
  /** Juice Shop origin, e.g. http://127.0.0.1:4001 */
  juiceOrigin: string
  /** sakuda origin, e.g. http://127.0.0.1:3001 */
  sakudaOrigin: string
  credentials: SeedCredentials
  /** The template after `applyJuiceOrigin`. */
  site: SiteTemplate
  fetch: typeof globalThis.fetch
}

export interface SeedJuiceShopResult {
  siteId: string
  action: 'created' | 'updated'
}

/** Points the template at `juiceOrigin`: `frontBaseUrl` and the OpenAPI
 * `servers[].url` are the only places the origin appears. Pure. */
export function applyJuiceOrigin(template: SiteTemplate, juiceOrigin: string): SiteTemplate {
  if (juiceOrigin === DEFAULT_JUICE_ORIGIN) return template
  return {
    ...template,
    frontBaseUrl: template.frontBaseUrl.replaceAll(DEFAULT_JUICE_ORIGIN, juiceOrigin),
    openapiJson: template.openapiJson?.replaceAll(DEFAULT_JUICE_ORIGIN, juiceOrigin) ?? null,
  }
}

/** `requestShapes` is keyed by `targetLineKey` (`METHOD|base|path`);
 * `POST /api/sites/:id/targets` wants the line grammar (`METHOD [api:]/path`)
 * plus the shape. Pure. */
export function shapesFromRequestShapes(shapes: Record<string, RequestShape>): TargetShape[] {
  return Object.entries(shapes).map(([key, shape]) => {
    const [method, base, path] = key.split('|')
    if (!method || !base || !path) throw new Error(`malformed requestShapes key "${key}"`)
    return {
      line: `${method} ${base === 'api' ? 'api:' : ''}${path}`,
      contentType: shape.contentType,
      bodyShape: shape.bodyShape,
    }
  })
}

/** An HTTP step that did not go as expected: which step, which status, and
 * (unless `detail` is withheld because the body may carry a token) what the
 * server said. */
export class SeedHttpError extends Error {
  readonly operation: string
  readonly status: number
  constructor(operation: string, status: number, detail: string | null) {
    super(`${operation} failed: HTTP ${status}${detail ? ` — ${detail}` : ''}`)
    this.name = 'SeedHttpError'
    this.operation = operation
    this.status = status
  }
}

async function bodySnippet(res: Response): Promise<string> {
  const text = await res.text()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

async function sendJson(
  fetch: typeof globalThis.fetch,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

/** Juice Shop: `POST /api/Users`. 201 on a new account; a 400 whose only
 * complaint is "email must be unique" means the account exists already,
 * which is the normal second-run case. Anything else is a real failure. */
async function registerDemoUser(i: SeedJuiceShopInput): Promise<void> {
  const res = await sendJson(i.fetch, 'POST', `${i.juiceOrigin}/api/Users`, {
    email: i.credentials.email,
    password: i.credentials.password,
    passwordRepeat: i.credentials.password,
    securityQuestion: { id: 1 },
    securityAnswer: i.credentials.securityAnswer,
  })
  if (res.ok) return
  const text = await res.text()
  if (res.status === 400 && /email must be unique/.test(text)) return
  throw new SeedHttpError('register demo user', res.status, text.slice(0, 300))
}

/** Juice Shop: `POST /rest/user/login` → `authentication.token`. The response
 * body carries the JWT, so it never reaches an error message. */
async function login(i: SeedJuiceShopInput): Promise<string> {
  const res = await sendJson(i.fetch, 'POST', `${i.juiceOrigin}/rest/user/login`, {
    email: i.credentials.email,
    password: i.credentials.password,
  })
  if (!res.ok) throw new SeedHttpError('login', res.status, null)
  const data: unknown = await res.json()
  const token =
    typeof data === 'object' &&
    data !== null &&
    'authentication' in data &&
    typeof data.authentication === 'object' &&
    data.authentication !== null &&
    'token' in data.authentication &&
    typeof data.authentication.token === 'string'
      ? data.authentication.token
      : null
  if (!token) throw new SeedHttpError('login', res.status, 'response has no authentication.token')
  return token
}

async function sakudaJson<T>(
  i: SeedJuiceShopInput,
  operation: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await sendJson(i.fetch, method, `${i.sakudaOrigin}${path}`, body)
  if (!res.ok) throw new SeedHttpError(operation, res.status, await bodySnippet(res))
  return (await res.json()) as T
}

/** The two request headers Juice Shop's server reads the session from (REST
 * / API routes want the bearer, `whoami` wants the cookie) and the one
 * localStorage key its SPA decides "logged in" from. */
function secretsFor(token: string) {
  return {
    headers: [
      { name: 'Authorization', value: `Bearer ${token}` },
      { name: 'Cookie', value: `token=${token}` },
    ],
    browserStorage: [{ kind: 'localStorage' as const, name: 'token', value: token }],
  }
}

/**
 * Register (or find) the demo user on Juice Shop, log in, and make sure
 * sakuda has one site named as the template with this run's JWT in its
 * headers and browser storage. Idempotent by site name: a missing site is
 * created from the template (then its non-GET shapes saved); an existing
 * one keeps every field as stored — including targets the user edited — and
 * only gets the fresh secrets.
 */
export async function seedJuiceShop(i: SeedJuiceShopInput): Promise<SeedJuiceShopResult> {
  await registerDemoUser(i)
  const token = await login(i)
  const secrets = secretsFor(token)

  const sites = await sakudaJson<Pick<SitePublic, 'id' | 'name'>[]>(
    i,
    'list sites',
    'GET',
    '/api/sites',
  )
  const existing = sites.find((s) => s.name === i.site.name)
  if (existing) {
    const current = await sakudaJson<SitePublic>(i, 'read site', 'GET', `/api/sites/${existing.id}`)
    await sakudaJson<SitePublic>(i, 'update site', 'PUT', `/api/sites/${existing.id}`, {
      ...siteFields(current),
      ...secrets,
    })
    return { siteId: existing.id, action: 'updated' }
  }

  const created = await sakudaJson<SitePublic>(i, 'create site', 'POST', '/api/sites', {
    ...siteFields(i.site),
    ...secrets,
  })
  const shapes = shapesFromRequestShapes(i.site.requestShapes)
  if (shapes.length > 0)
    await sakudaJson(i, 'save request shapes', 'POST', `/api/sites/${created.id}/targets`, {
      lines: shapes.map((s) => s.line),
      shapes,
    })
  return { siteId: created.id, action: 'created' }
}
