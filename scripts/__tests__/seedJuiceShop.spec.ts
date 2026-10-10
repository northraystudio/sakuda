import { describe, expect, it } from 'vitest'
import {
  applyJuiceOrigin,
  DEFAULT_JUICE_ORIGIN,
  seedJuiceShop,
  shapesFromRequestShapes,
  type SiteTemplate,
} from '../lib/seedJuiceShop.ts'

const template: SiteTemplate = {
  name: 'Juice Shop',
  frontBaseUrl: 'http://127.0.0.1:4001',
  apiBaseUrl: null,
  nucleiPaths: '/\n/rest/products/search?q=\nPOST /api/Users/\n',
  openapiUrl: null,
  openapiJson: '{"openapi":"3.0.0","servers":[{"url":"http://127.0.0.1:4001"}],"paths":{}}',
  zapFeSeedPath: '/#/',
  discoverySeedPaths: '/#/\n/#/search?q=',
  crawlScopePaths: '',
  excludePaths: '',
  nucleiRateLimit: 50,
  nucleiMaxMinutes: null,
  nucleiConcurrency: null,
  zapApiMaxMinutes: 45,
  zapFeSpiderMaxMinutes: 5,
  nonLocalConfirmed: false,
  allowMutatingRequests: true,
  nucleiEnabledRiskTags: ['fuzz'],
  requestShapes: {
    'POST|front|/api/Users/': {
      contentType: 'application/json',
      bodyShape: {
        kind: 'json',
        root: { type: 'object', fields: { email: { type: 'string' } } },
      },
    },
  },
}

const credentials = { email: 'demo@sakuda.local', password: 'pw', securityAnswer: 'sakuda' }
const TOKEN = 'eyJ.fake.jwt'

interface Call {
  method: string
  url: string
  body: unknown
}

/** A fake network: a handler per "METHOD url" that returns a Response. */
function fakeFetch(routes: Record<string, (body: unknown) => Response>) {
  const calls: Call[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body })
    const handler = routes[`${method} ${url}`]
    if (!handler) throw new Error(`unexpected request ${method} ${url}`)
    return handler(body)
  }
  return { fetch, calls }
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

const JUICE = 'http://127.0.0.1:4002'
const SAKUDA = 'http://127.0.0.1:3001'

const secretsSent = {
  headers: [
    { name: 'Authorization', value: `Bearer ${TOKEN}` },
    { name: 'Cookie', value: `token=${TOKEN}` },
  ],
  browserStorage: [{ kind: 'localStorage', name: 'token', value: TOKEN }],
}

describe('applyJuiceOrigin', () => {
  it('rewrites the default origin in frontBaseUrl and openapiJson, nothing else', () => {
    const t = applyJuiceOrigin(template, JUICE)
    expect(t.frontBaseUrl).toBe(JUICE)
    expect(JSON.parse(t.openapiJson!)).toEqual({
      openapi: '3.0.0',
      servers: [{ url: JUICE }],
      paths: {},
    })
    expect(t.nucleiPaths).toBe(template.nucleiPaths)
    expect(t.requestShapes).toEqual(template.requestShapes)
    expect(template.frontBaseUrl).toBe(DEFAULT_JUICE_ORIGIN) // input untouched
  })

  it('is a no-op for the default origin', () => {
    expect(applyJuiceOrigin(template, DEFAULT_JUICE_ORIGIN)).toEqual(template)
  })
})

describe('shapesFromRequestShapes', () => {
  it('turns each targetLineKey into a target line + shape, with the api: prefix when the base is api', () => {
    const shape = template.requestShapes['POST|front|/api/Users/']!
    expect(
      shapesFromRequestShapes({
        'POST|front|/api/Users/': shape,
        'PUT|api|/v1/things': shape,
      }),
    ).toEqual([
      { line: 'POST /api/Users/', contentType: shape.contentType, bodyShape: shape.bodyShape },
      { line: 'PUT api:/v1/things', contentType: shape.contentType, bodyShape: shape.bodyShape },
    ])
  })
})

describe('seedJuiceShop', () => {
  it('first run: registers, logs in, creates the site with secrets, then saves the non-GET shapes', async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${JUICE}/api/Users`]: () => json(201, { status: 'success', data: { id: 1 } }),
      [`POST ${JUICE}/rest/user/login`]: () =>
        json(200, { authentication: { token: TOKEN, bid: 1, umail: credentials.email } }),
      [`GET ${SAKUDA}/api/sites`]: () => json(200, []),
      [`POST ${SAKUDA}/api/sites`]: () => json(201, { id: 'site-1', name: 'Juice Shop' }),
      [`POST ${SAKUDA}/api/sites/site-1/targets`]: () =>
        json(200, { site: { id: 'site-1' }, added: [], skipped: ['POST /api/Users/'] }),
    })
    const site = applyJuiceOrigin(template, JUICE)
    const result = await seedJuiceShop({
      juiceOrigin: JUICE,
      sakudaOrigin: SAKUDA,
      credentials,
      site,
      fetch,
    })
    expect(result).toEqual({ siteId: 'site-1', action: 'created' })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${JUICE}/api/Users`,
      `POST ${JUICE}/rest/user/login`,
      `GET ${SAKUDA}/api/sites`,
      `POST ${SAKUDA}/api/sites`,
      `POST ${SAKUDA}/api/sites/site-1/targets`,
    ])
    expect(calls[0]!.body).toEqual({
      email: credentials.email,
      password: credentials.password,
      passwordRepeat: credentials.password,
      securityQuestion: { id: 1 },
      securityAnswer: credentials.securityAnswer,
    })
    expect(calls[1]!.body).toEqual({ email: credentials.email, password: credentials.password })
    const { requestShapes, ...fields } = site
    expect(calls[3]!.body).toEqual({ ...fields, ...secretsSent })
    expect(calls[4]!.body).toEqual({
      lines: ['POST /api/Users/'],
      shapes: shapesFromRequestShapes(requestShapes),
    })
  })

  it('second run: an already-registered user is fine, and the existing site gets only fresh secrets', async () => {
    const current = {
      id: 'site-1',
      ...template,
      nucleiPaths: '/\n/edited-by-user\n', // the user's list must survive
      requestShapes: {},
      headerNames: ['Authorization', 'Cookie'],
      browserStorageNames: [{ kind: 'localStorage', name: 'token' }],
      requiresConfirmation: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
    const { fetch, calls } = fakeFetch({
      [`POST ${JUICE}/api/Users`]: () =>
        json(400, {
          message: 'Validation error',
          errors: [{ field: 'email', message: 'email must be unique' }],
        }),
      [`POST ${JUICE}/rest/user/login`]: () =>
        json(200, { authentication: { token: TOKEN, bid: 1, umail: credentials.email } }),
      [`GET ${SAKUDA}/api/sites`]: () =>
        json(200, [
          { id: 'other', name: 'Other site' },
          { id: 'site-1', name: 'Juice Shop' },
        ]),
      [`GET ${SAKUDA}/api/sites/site-1`]: () => json(200, current),
      [`PUT ${SAKUDA}/api/sites/site-1`]: () => json(200, current),
    })
    const result = await seedJuiceShop({
      juiceOrigin: JUICE,
      sakudaOrigin: SAKUDA,
      credentials,
      site: template,
      fetch,
    })
    expect(result).toEqual({ siteId: 'site-1', action: 'updated' })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${JUICE}/api/Users`,
      `POST ${JUICE}/rest/user/login`,
      `GET ${SAKUDA}/api/sites`,
      `GET ${SAKUDA}/api/sites/site-1`,
      `PUT ${SAKUDA}/api/sites/site-1`,
    ])
    const { requestShapes, ...templateFields } = template
    expect(calls[4]!.body).toEqual({
      ...templateFields,
      nucleiPaths: '/\n/edited-by-user\n',
      ...secretsSent,
    })
  })

  it('stops at a failed registration that is not "already registered"', async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${JUICE}/api/Users`]: () =>
        json(400, { errors: [{ field: 'password', message: 'too short' }] }),
    })
    await expect(
      seedJuiceShop({
        juiceOrigin: JUICE,
        sakudaOrigin: SAKUDA,
        credentials,
        site: template,
        fetch,
      }),
    ).rejects.toThrow(/register demo user.*400/)
    expect(calls).toHaveLength(1)
  })

  it('stops at a failed login without touching sakuda, and never puts the response body in the error', async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${JUICE}/api/Users`]: () => json(201, {}),
      [`POST ${JUICE}/rest/user/login`]: () => json(401, 'Invalid email or password.'),
    })
    await expect(
      seedJuiceShop({
        juiceOrigin: JUICE,
        sakudaOrigin: SAKUDA,
        credentials,
        site: template,
        fetch,
      }),
    ).rejects.toThrow(/login.*401/)
    expect(calls).toHaveLength(2)
  })

  it('surfaces a sakuda error with its status and body', async () => {
    const { fetch } = fakeFetch({
      [`POST ${JUICE}/api/Users`]: () => json(201, {}),
      [`POST ${JUICE}/rest/user/login`]: () => json(200, { authentication: { token: TOKEN } }),
      [`GET ${SAKUDA}/api/sites`]: () => json(200, []),
      [`POST ${SAKUDA}/api/sites`]: () =>
        json(422, { statusMessage: 'validation failed', data: { nucleiPaths: ['bad'] } }),
    })
    await expect(
      seedJuiceShop({
        juiceOrigin: JUICE,
        sakudaOrigin: SAKUDA,
        credentials,
        site: template,
        fetch,
      }),
    ).rejects.toThrow(/create site.*422.*validation failed/)
  })
})
