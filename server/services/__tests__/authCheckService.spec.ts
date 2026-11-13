import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../../db/client'
import { sites } from '../../db/schema'
import { createSiteCipher } from '../../domain/headerCipher'
import { logger } from '../../lib/logger'
import { checkAuthDraft, checkSavedSiteAuth, type AuthCheckDeps } from '../authCheckService'
import type { AuthCheckSend } from '../authWatch'
import { ServiceError } from '../errors'
import { createSite, type SiteServiceDeps } from '../siteService'
import { AuthCheckInputSchema, SiteInputSchema } from '#shared/schemas/site'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const STORED = 'Bearer stored-token'

let siteDeps: SiteServiceDeps
let send: ReturnType<typeof vi.fn<AuthCheckSend>>
let deps: AuthCheckDeps

beforeEach(() => {
  siteDeps = {
    db: openDatabase({ file: ':memory:', migrationsFolder }),
    cipher: createSiteCipher(randomBytes(32).toString('base64')),
    now: () => new Date('2026-02-01T00:00:00.000Z'),
    id: randomUUID,
  }
  send = vi.fn<AuthCheckSend>(async () => 200)
  deps = { site: siteDeps, send, logger }
})

function storedSite(extra: Record<string, unknown> = {}) {
  return createSite(siteDeps, {
    ...SiteInputSchema.parse({
      name: 'shop',
      frontBaseUrl: 'http://localhost:3000',
      apiBaseUrl: 'http://localhost:3001',
      ...extra,
    }),
    headers: [{ name: 'Authorization', value: STORED }],
  })
}

const draft = (v: Record<string, unknown>) =>
  AuthCheckInputSchema.parse({ frontBaseUrl: 'http://localhost:3000', authCheckPath: '/me', ...v })

describe('checkAuthDraft', () => {
  it('fills a value-less header row from the stored one (edit mode)', async () => {
    const site = storedSite()
    const result = await checkAuthDraft(
      deps,
      site.id,
      draft({ headers: [{ name: 'Authorization' }, { name: 'X-Tenant', value: 'a' }] }),
    )
    expect(result).toEqual({ outcome: 'ok', status: 200, path: '/me' })
    expect(send).toHaveBeenCalledWith(
      'http://localhost:3000/me',
      [
        { name: 'Authorization', value: STORED },
        { name: 'X-Tenant', value: 'a' },
      ],
      expect.any(AbortSignal),
    )
  })

  it('uses a typed value over the stored one, and the API base for api:', async () => {
    const site = storedSite()
    await checkAuthDraft(
      deps,
      site.id,
      draft({
        apiBaseUrl: 'http://localhost:3001',
        authCheckPath: 'api:/me',
        headers: [{ name: 'Authorization', value: 'Bearer new' }],
      }),
    )
    expect(send).toHaveBeenCalledWith(
      'http://localhost:3001/me',
      [{ name: 'Authorization', value: 'Bearer new' }],
      expect.any(AbortSignal),
    )
  })

  it('needs every header value for a new site', async () => {
    await expect(
      checkAuthDraft(deps, null, draft({ headers: [{ name: 'Authorization' }] })),
    ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION' })
    expect(send).not.toHaveBeenCalled()
  })

  it('is 404 for an unknown site', async () => {
    await expect(checkAuthDraft(deps, 'nope', draft({}))).rejects.toBeInstanceOf(ServiceError)
  })

  it('reports no-answer, without throwing, when the request fails', async () => {
    send.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect(await checkAuthDraft(deps, null, draft({}))).toEqual({
      outcome: 'no-answer',
      status: null,
      path: '/me',
    })
  })
})

describe('checkSavedSiteAuth', () => {
  it('checks the saved path with the saved headers', async () => {
    const site = storedSite({ authCheckPath: '/account' })
    send.mockResolvedValueOnce(401)
    expect(await checkSavedSiteAuth(deps, site.id)).toEqual({
      outcome: 'rejected',
      status: 401,
      path: '/account',
    })
    expect(send).toHaveBeenCalledWith(
      'http://localhost:3000/account',
      [{ name: 'Authorization', value: STORED }],
      expect.any(AbortSignal),
    )
  })

  it('refuses a site without a check path', async () => {
    const site = storedSite()
    await expect(checkSavedSiteAuth(deps, site.id)).rejects.toMatchObject({
      code: 'AUTH_CHECK_NOT_SET',
    })
  })

  it('refuses a non-local site the user has not confirmed', async () => {
    const site = storedSite({ authCheckPath: '/me' })
    // A row written before the confirmation rule, or edited outside the form.
    siteDeps.db
      .update(sites)
      .set({ frontBaseUrl: 'https://shop.example.com', nonLocalConfirmed: false })
      .where(eq(sites.id, site.id))
      .run()
    await expect(checkSavedSiteAuth(deps, site.id)).rejects.toMatchObject({
      code: 'NON_LOCAL_NOT_CONFIRMED',
    })
    expect(send).not.toHaveBeenCalled()
  })
})
