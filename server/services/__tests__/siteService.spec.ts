import { beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../../db/client'
import { scans } from '../../db/schema'
import { createSiteCipher } from '../../domain/headerCipher'
import { createScan } from '../scanService'
import { ServiceError } from '../errors'
import { createDiscovery } from '../discoveryService'
import {
  addSiteTargets,
  createSite,
  deleteSite,
  getSite,
  getSiteSecrets,
  listSites,
  loadSiteWithHeaders,
  removeSiteTarget,
  updateSite,
  type SiteServiceDeps,
} from '../siteService'
import { SiteInputSchema } from '#shared/schemas/site'

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const base = SiteInputSchema.parse({
  name: 'shop',
  frontBaseUrl: 'http://localhost:3001/',
  nucleiPaths: '/\n/api/products',
})
let deps: SiteServiceDeps
let n = 0

beforeEach(() => {
  deps = {
    db: openDatabase({ file: ':memory:', migrationsFolder }),
    cipher: createSiteCipher(randomBytes(32).toString('base64')),
    now: () => new Date('2026-01-01T00:00:00Z'),
    id: () => `id-${++n}`,
  }
})

describe('siteService', () => {
  it('creates a site, strips trailing slash, never exposes header values', () => {
    const s = createSite(deps, { ...base, headers: [{ name: 'Cookie', value: 'secret=1' }] })
    expect(s.frontBaseUrl).toBe('http://localhost:3001')
    expect(s.headerNames).toEqual(['Cookie'])
    expect(JSON.stringify(s)).not.toContain('secret=1')
    expect(loadSiteWithHeaders(deps, s.id)?.headers).toEqual([
      { name: 'Cookie', value: 'secret=1' },
    ])
  })

  it('getSiteSecrets returns the decrypted header and storage values (#17)', () => {
    const s = createSite(deps, {
      ...base,
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
      browserStorage: [{ kind: 'localStorage', name: 'token', value: 'eyJ.x' }],
    })
    expect(getSiteSecrets(deps, s.id)).toEqual({
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
      browserStorage: [{ kind: 'localStorage', name: 'token', value: 'eyJ.x' }],
    })
    expect(getSiteSecrets(deps, 'missing')).toBeNull()
  })

  it('update keeps headers when omitted and clears them with []', () => {
    const s = createSite(deps, { ...base, headers: [{ name: 'Cookie', value: 'v' }] })
    expect(updateSite(deps, s.id, { ...base, name: 'renamed' }).headerNames).toEqual(['Cookie'])
    expect(updateSite(deps, s.id, { ...base, headers: [] }).headerNames).toEqual([])
    expect(loadSiteWithHeaders(deps, s.id)?.headers).toEqual([])
  })

  describe('update merges header rows against the stored set', () => {
    const stored = [
      { name: 'Authorization', value: 'Bearer old' },
      { name: 'Cookie', value: 'token=old' },
    ]

    it('a row without value keeps the stored value; a row with value replaces it', () => {
      const s = createSite(deps, { ...base, headers: stored })
      const updated = updateSite(deps, s.id, {
        ...base,
        headers: [{ name: 'Authorization' }, { name: 'Cookie', value: 'token=new' }],
      })
      expect(updated.headerNames).toEqual(['Authorization', 'Cookie'])
      expect(loadSiteWithHeaders(deps, s.id)?.headers).toEqual([
        { name: 'Authorization', value: 'Bearer old' },
        { name: 'Cookie', value: 'token=new' },
      ])
    })

    it('a stored name missing from the list is deleted', () => {
      const s = createSite(deps, { ...base, headers: stored })
      updateSite(deps, s.id, { ...base, headers: [{ name: 'Cookie' }] })
      expect(loadSiteWithHeaders(deps, s.id)?.headers).toEqual([
        { name: 'Cookie', value: 'token=old' },
      ])
    })

    it('a new name with a value is added alongside kept rows', () => {
      const s = createSite(deps, { ...base, headers: stored })
      updateSite(deps, s.id, {
        ...base,
        headers: [{ name: 'Authorization' }, { name: 'Cookie' }, { name: 'X-Api-Key', value: 'k' }],
      })
      expect(loadSiteWithHeaders(deps, s.id)?.headers).toEqual([
        ...stored,
        { name: 'X-Api-Key', value: 'k' },
      ])
    })

    it('a row without value whose name is not stored is a 422 and writes nothing', () => {
      const s = createSite(deps, { ...base, headers: stored })
      let caught: unknown
      try {
        updateSite(deps, s.id, {
          ...base,
          name: 'renamed',
          headers: [{ name: 'Authorization' }, { name: 'X-Missing' }, { name: 'authorization' }],
        })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(ServiceError)
      const err = caught as ServiceError
      expect(err.statusCode).toBe(422)
      expect(err.code).toBe('VALIDATION')
      expect(err.message).toContain('X-Missing')
      expect(err.message).toContain('authorization')
      expect(err.message).not.toContain('old')
      expect(getSite(deps.db, s.id)?.name).toBe('shop')
      expect(loadSiteWithHeaders(deps, s.id)?.headers).toEqual(stored)
    })
  })

  it('seals browser storage like headers: names exposed, values write-only, [] clears', () => {
    const storage = [
      { kind: 'localStorage' as const, name: 'token', value: 'eyJ.secret' },
      { kind: 'sessionStorage' as const, name: 'bid', value: '6' },
    ]
    const s = createSite(deps, { ...base, browserStorage: storage })
    expect(s.browserStorageNames).toEqual([
      { kind: 'localStorage', name: 'token' },
      { kind: 'sessionStorage', name: 'bid' },
    ])
    expect(JSON.stringify(s)).not.toContain('eyJ.secret')
    expect(loadSiteWithHeaders(deps, s.id)?.browserStorage).toEqual(storage)
    // omitted → kept; [] → cleared
    expect(updateSite(deps, s.id, { ...base, name: 'renamed' }).browserStorageNames).toHaveLength(2)
    expect(loadSiteWithHeaders(deps, s.id)?.browserStorage).toEqual(storage)
    expect(updateSite(deps, s.id, { ...base, browserStorage: [] }).browserStorageNames).toEqual([])
    expect(loadSiteWithHeaders(deps, s.id)?.browserStorage).toEqual([])
  })

  describe('update merges browser storage rows against the stored set', () => {
    const stored = [
      { kind: 'localStorage' as const, name: 'token', value: 'eyJ.old' },
      { kind: 'cookie' as const, name: 'sid', value: 'old' },
    ]

    it('a row without value keeps the stored value; a row with value replaces it', () => {
      const s = createSite(deps, { ...base, browserStorage: stored })
      const updated = updateSite(deps, s.id, {
        ...base,
        browserStorage: [
          { kind: 'localStorage', name: 'token' },
          { kind: 'cookie', name: 'sid', value: 'new' },
        ],
      })
      expect(updated.browserStorageNames).toEqual([
        { kind: 'localStorage', name: 'token' },
        { kind: 'cookie', name: 'sid' },
      ])
      expect(loadSiteWithHeaders(deps, s.id)?.browserStorage).toEqual([
        { kind: 'localStorage', name: 'token', value: 'eyJ.old' },
        { kind: 'cookie', name: 'sid', value: 'new' },
      ])
    })

    it('a stored item missing from the list is deleted; a new item is added', () => {
      const s = createSite(deps, { ...base, browserStorage: stored })
      updateSite(deps, s.id, {
        ...base,
        browserStorage: [
          { kind: 'cookie', name: 'sid' },
          { kind: 'sessionStorage', name: 'bid', value: '6' },
        ],
      })
      expect(loadSiteWithHeaders(deps, s.id)?.browserStorage).toEqual([
        { kind: 'cookie', name: 'sid', value: 'old' },
        { kind: 'sessionStorage', name: 'bid', value: '6' },
      ])
    })

    it('same name but different kind is a distinct item, not a match', () => {
      const s = createSite(deps, { ...base, browserStorage: stored })
      let caught: unknown
      try {
        // localStorage:token is stored, but sessionStorage:token is not
        updateSite(deps, s.id, {
          ...base,
          browserStorage: [{ kind: 'sessionStorage', name: 'token' }],
        })
      } catch (e) {
        caught = e
      }
      expect((caught as ServiceError).statusCode).toBe(422)
      expect(loadSiteWithHeaders(deps, s.id)?.browserStorage).toEqual(stored)
    })

    it('a row without value whose (kind, name) is not stored is a 422 and writes nothing', () => {
      const s = createSite(deps, { ...base, browserStorage: stored })
      let caught: unknown
      try {
        updateSite(deps, s.id, {
          ...base,
          name: 'renamed',
          browserStorage: [
            { kind: 'localStorage', name: 'token' },
            { kind: 'localStorage', name: 'missing' },
          ],
        })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(ServiceError)
      const err = caught as ServiceError
      expect(err.statusCode).toBe(422)
      expect(err.code).toBe('VALIDATION')
      expect(err.message).toContain('localStorage:missing')
      expect(err.message).not.toContain('eyJ.old')
      expect(getSite(deps.db, s.id)?.name).toBe('shop')
      expect(loadSiteWithHeaders(deps, s.id)?.browserStorage).toEqual(stored)
    })
  })

  it('lists with lastScan null, gets, deletes', async () => {
    const s = createSite(deps, base)
    expect(listSites(deps.db)[0]).toMatchObject({
      id: s.id,
      lastScan: null,
      requiresConfirmation: false,
    })
    expect(getSite(deps.db, s.id)?.name).toBe('shop')
    expect(await deleteSite(deps.db, s.id)).toBe(true)
    expect(getSite(deps.db, s.id)).toBeNull()
  })

  it('update of unknown id throws ServiceError 404', () => {
    expect(() => updateSite(deps, 'nope', base)).toThrow(/not found/)
  })

  it('deleting a site best-effort removes its scan and discovery artifact directories (I5)', async () => {
    const s = createSite(deps, base)
    const scan = createScan(deps.db, { now: deps.now, id: deps.id }, s.id, ['nuclei'])
    const scansDir = mkdtempSync(join(tmpdir(), 'sakuda-scans-'))
    const scanDir = join(scansDir, scan.id)
    mkdirSync(join(scanDir, 'nuclei'), { recursive: true })
    writeFileSync(join(scanDir, 'nuclei', 'findings.jsonl'), '{}')
    const logger = pino({ level: 'silent' })

    // one job at a time per site: finish the scan before queueing a discovery
    deps.db.update(scans).set({ status: 'done' }).where(eq(scans.id, scan.id)).run()
    const discovery = createDiscovery(deps.db, { now: deps.now, id: deps.id }, s.id)
    const discoveriesDir = mkdtempSync(join(tmpdir(), 'sakuda-discoveries-'))
    const discoveryDir = join(discoveriesDir, discovery.id)
    mkdirSync(discoveryDir, { recursive: true })
    writeFileSync(join(discoveryDir, 'site-tree.jsonl'), '')

    expect(await deleteSite(deps.db, s.id, { scansDir, discoveriesDir, logger })).toBe(true)

    expect(existsSync(scanDir)).toBe(false)
    expect(existsSync(discoveryDir)).toBe(false)
  })

  it('deleting a site logs (never throws) when an artifact directory cannot be removed', async () => {
    const s = createSite(deps, base)
    createScan(deps.db, { now: deps.now, id: deps.id }, s.id, ['nuclei'])
    const logger = pino({ level: 'silent' })
    let warned = false
    logger.warn = ((...args: unknown[]) => {
      warned = true
      return args
    }) as typeof logger.warn

    // scansDir points at a path that cannot contain the scan subdirectory
    // (its parent is a file, not a directory) so `rm` fails.
    const notADir = mkdtempSync(join(tmpdir(), 'sakuda-notadir-'))
    writeFileSync(join(notADir, 'blocker'), '')
    const scansDir = join(notADir, 'blocker')

    await expect(
      deleteSite(deps.db, s.id, { scansDir, discoveriesDir: scansDir, logger }),
    ).resolves.toBe(true)
    expect(warned).toBe(true)
  })

  describe('addSiteTargets', () => {
    it('appends new lines, skips duplicates, and bumps updatedAt', () => {
      const s = createSite(deps, base) // nucleiPaths: '/\n/api/products'
      deps.now = () => new Date('2026-02-01T00:00:00Z')
      const r = addSiteTargets(deps, s.id, [
        '/api/products',
        '/login',
        'api:/v1'.replace('api:', ''),
      ])
      expect(r.added).toEqual(['/login', '/v1'])
      expect(r.skipped).toEqual(['/api/products'])
      expect(r.site.nucleiPaths).toBe('/\n/api/products\n/login\n/v1\n')
      expect(r.site.updatedAt).toBe('2026-02-01T00:00:00.000Z')
      expect(getSite(deps.db, s.id)?.nucleiPaths).toBe('/\n/api/products\n/login\n/v1\n')
    })

    it('is a no-op (no updatedAt bump) when every line is already present', () => {
      const s = createSite(deps, base)
      deps.now = () => new Date('2026-02-01T00:00:00Z')
      const r = addSiteTargets(deps, s.id, ['/'])
      expect(r.added).toEqual([])
      expect(r.site.updatedAt).toBe(s.updatedAt)
    })

    it('rejects invalid lines with 422 and writes nothing', () => {
      const s = createSite(deps, base)
      expect(() => addSiteTargets(deps, s.id, ['/ok', 'http://x.example/abs'])).toThrow(
        ServiceError,
      )
      try {
        addSiteTargets(deps, s.id, ['/ok', 'http://x.example/abs'])
      } catch (e) {
        if (!(e instanceof ServiceError)) throw e
        expect(e.statusCode).toBe(422)
        expect(e.details).toEqual({ invalid: ['http://x.example/abs'] })
      }
      expect(getSite(deps.db, s.id)?.nucleiPaths).toBe(base.nucleiPaths)
    })

    it('rejects api: lines when the site has no apiBaseUrl', () => {
      const s = createSite(deps, base)
      expect(() => addSiteTargets(deps, s.id, ['api:/v1/users'])).toThrow(/apiBaseUrl/)
      expect(
        addSiteTargets(
          deps,
          createSite(deps, { ...base, apiBaseUrl: 'http://localhost:8080' }).id,
          ['api:/v1/users'],
        ).added,
      ).toEqual(['api:/v1/users'])
    })

    it('rejects a save that would push nucleiPaths over the site schema limit (site stays editable)', () => {
      const s = createSite(deps, base)
      const huge = Array.from({ length: 400 }, (_, i) => `/p${i}/${'x'.repeat(60)}`)
      expect(() => addSiteTargets(deps, s.id, huge)).toThrow(/over the 20000 limit/)
      expect(getSite(deps.db, s.id)?.nucleiPaths).toBe(base.nucleiPaths)
      // the form's schema must still accept the untouched site
      expect(
        SiteInputSchema.safeParse({ ...base, nucleiPaths: getSite(deps.db, s.id)?.nucleiPaths })
          .success,
      ).toBe(true)
    })

    it('throws 404 for an unknown site', () => {
      expect(() => addSiteTargets(deps, 'nope', ['/'])).toThrow(/not found/)
    })
  })

  describe('removeSiteTarget', () => {
    it('removes the matching line, keeps the others, and bumps updatedAt', () => {
      const s = createSite(deps, base) // nucleiPaths: '/\n/api/products'
      deps.now = () => new Date('2026-02-01T00:00:00Z')
      const r = removeSiteTarget(deps, s.id, 'GET /api/products')
      expect(r.removed).toBe(true)
      expect(r.site.nucleiPaths).toBe('/')
      expect(r.site.updatedAt).toBe('2026-02-01T00:00:00.000Z')
      expect(getSite(deps.db, s.id)?.nucleiPaths).toBe('/')
    })

    it('is idempotent: a line that is not saved changes nothing (no updatedAt bump)', () => {
      const s = createSite(deps, base)
      deps.now = () => new Date('2026-02-01T00:00:00Z')
      const r = removeSiteTarget(deps, s.id, '/missing')
      expect(r.removed).toBe(false)
      expect(r.site.nucleiPaths).toBe(s.nucleiPaths)
      expect(r.site.updatedAt).toBe(s.updatedAt)
    })

    it('drops the request shape saved under the removed line', () => {
      const s = createSite(deps, base)
      const shape = {
        line: 'POST /rest/user/login',
        contentType: 'application/json',
        bodyShape: { kind: 'form' as const, fields: ['email', 'password'] },
      }
      addSiteTargets(
        deps,
        s.id,
        ['POST /rest/user/login', 'POST /rest/other'],
        [shape, { ...shape, line: 'POST /rest/other' }],
      )
      const r = removeSiteTarget(deps, s.id, 'POST /rest/user/login')
      expect(r.site.nucleiPaths).toBe('/\n/api/products\nPOST /rest/other\n')
      expect(Object.keys(r.site.requestShapes)).toEqual(['POST|front|/rest/other'])
    })

    it('rejects an invalid line with 422 and writes nothing', () => {
      const s = createSite(deps, base)
      expect(() => removeSiteTarget(deps, s.id, 'http://absolute.example/x')).toThrow(ServiceError)
      expect(getSite(deps.db, s.id)?.nucleiPaths).toBe(s.nucleiPaths)
    })

    it('throws 404 for an unknown site', () => {
      expect(() => removeSiteTarget(deps, 'nope', '/')).toThrow(ServiceError)
    })
  })

  describe('request shapes of approved non-GET lines', () => {
    const loginShape = {
      line: 'POST /rest/user/login',
      contentType: 'application/json',
      bodyShape: {
        kind: 'json' as const,
        root: {
          type: 'object' as const,
          fields: { email: { type: 'string' as const }, password: { type: 'string' as const } },
        },
      },
    }

    it('saves a shape under the approved line key, exposes it, and stores no values', () => {
      const s = createSite(deps, base)
      const r = addSiteTargets(deps, s.id, ['POST /rest/user/login'], [loginShape])
      expect(r.site.requestShapes).toEqual({
        'POST|front|/rest/user/login': {
          contentType: 'application/json',
          bodyShape: loginShape.bodyShape,
        },
      })
      // shape carries names + types only — never a value
      expect(JSON.stringify(r.site.requestShapes)).not.toContain('hunter')
    })

    it('overwrites the shape when the same line is approved again', () => {
      const s = createSite(deps, base)
      addSiteTargets(deps, s.id, ['POST /rest/user/login'], [loginShape])
      const r = addSiteTargets(
        deps,
        s.id,
        ['POST /rest/user/login'],
        [{ ...loginShape, bodyShape: { kind: 'form', fields: ['email', 'password', 'otp'] } }],
      )
      expect(r.site.requestShapes['POST|front|/rest/user/login']?.bodyShape).toEqual({
        kind: 'form',
        fields: ['email', 'password', 'otp'],
      })
    })

    it('ignores a shape whose line is not among the saved targets, and GET shapes', () => {
      const s = createSite(deps, base)
      const r = addSiteTargets(
        deps,
        s.id,
        ['POST /rest/user/login'],
        [
          loginShape,
          { ...loginShape, line: 'POST /rest/not-approved' },
          { ...loginShape, line: '/rest/user/login' }, // GET
        ],
      )
      expect(Object.keys(r.site.requestShapes)).toEqual(['POST|front|/rest/user/login'])
    })

    it('updateSite drops the shape when its line is removed from nucleiPaths', () => {
      const s = createSite(deps, base)
      addSiteTargets(deps, s.id, ['POST /rest/user/login'], [loginShape])
      // Edit rewrites nucleiPaths without the POST line → its shape is pruned.
      const updated = updateSite(deps, s.id, { ...base, nucleiPaths: '/\n/api/products' })
      expect(updated.requestShapes).toEqual({})
      // and kept when the line stays
      addSiteTargets(deps, s.id, ['POST /rest/user/login'], [loginShape])
      const kept = updateSite(deps, s.id, {
        ...base,
        nucleiPaths: '/\nPOST /rest/user/login',
      })
      expect(Object.keys(kept.requestShapes)).toEqual(['POST|front|/rest/user/login'])
    })
  })
})
