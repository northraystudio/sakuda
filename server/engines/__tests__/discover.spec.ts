import { randomBytes } from 'node:crypto'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { parseEnv } from '../../config/env'
import type { SiteWithHeaders } from '../../services/siteService'
import { createDiscoverRunner } from '../discover'
import { EngineError, type DiscoverInput, type DiscoverOutput } from '../types'
import type { DiscoveredUrl } from '#shared/types/api'

const site: SiteWithHeaders = {
  id: 'site-1',
  name: 'shop',
  frontBaseUrl: 'http://localhost:3000',
  apiBaseUrl: null,
  nucleiPaths: '',
  openapiUrl: null,
  openapiJson: null,
  zapFeSeedPath: '/',
  discoverySeedPaths: '',
  crawlScopePaths: '',
  excludePaths: '',
  nucleiRateLimit: 50,
  zapApiMaxMinutes: 45,
  zapFeSpiderMaxMinutes: 5,
  nonLocalConfirmed: false,
  allowMutatingRequests: false,
  nucleiEnabledRiskTags: [],
  nucleiTags: [],
  openapiAllowedOrigins: [],
  headerNames: [],
  browserStorageNames: [],
  requiresConfirmation: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  headers: [],
  browserStorage: [],
}

const input: DiscoverInput = {
  discoveryId: 'disc-1',
  site,
  workDir: '/tmp/unused',
  env: parseEnv({ SAKUDA_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),
  logger: pino({ level: 'silent' }),
  signal: new AbortController().signal,
}

const url = (
  path: string,
  source: DiscoveredUrl['source'],
  statusCode = 200,
  method = 'GET',
): DiscoveredUrl => ({
  url: `http://localhost:3000${path}`,
  method,
  statusCode,
  source,
})

const output = (urls: DiscoveredUrl[], extra: Partial<DiscoverOutput> = {}): DiscoverOutput => ({
  urls,
  meta: { urlCount: urls.length },
  warnings: [],
  exitCode: 0,
  signal: null,
  ...extra,
})

const resolved = (out: DiscoverOutput) => async (): Promise<DiscoverOutput> => out
const rejected = (e: unknown) => async (): Promise<DiscoverOutput> => {
  throw e
}

describe('createDiscoverRunner', () => {
  it('merges both sources, ZAP first, deduping on URL', async () => {
    const zap = output([url('/', 'spider'), url('/rest/basket/6', 'ajax', 401)], {
      meta: { spider: 'traditional + ajax', nodeCount: 12, urlCount: 2 },
      warnings: ['zap warning'],
    })
    const katana = output(
      [
        url('/', 'katana'),
        url('/api/Feedbacks', 'katana'),
        url('/rest/user/whoami', 'katana', 401),
      ],
      { meta: { rawCount: 9, urlCount: 3, durationSec: 15 }, warnings: ['katana warning'] },
    )
    const run = createDiscoverRunner({ zap: resolved(zap), katana: resolved(katana) })

    const out = await run(input)

    expect(out.urls).toEqual([
      url('/', 'spider'),
      url('/rest/basket/6', 'ajax', 401),
      url('/api/Feedbacks', 'katana'),
      url('/rest/user/whoami', 'katana', 401),
    ])
    expect(out.warnings).toEqual(['zap warning', 'katana warning'])
    // ZAP's meta keys stay at the top level (the panel reads meta.nodeCount);
    // urlCount becomes the merged count; katana's meta is nested.
    expect(out.meta).toEqual({
      spider: 'traditional + ajax',
      nodeCount: 12,
      urlCount: 4,
      katana: { rawCount: 9, urlCount: 3, durationSec: 15 },
      merged: { urlCount: 4, duplicates: 1, capped: 0 },
    })
    expect(out.exitCode).toBe(0)
  })

  it('keeps a GET/POST pair on the same URL across sources (dedupe is method|url)', async () => {
    const zap = output([url('/x', 'spider', 200, 'GET')])
    const katana = output([url('/x', 'katana', 405, 'POST'), url('/x', 'katana', 200, 'GET')])
    const run = createDiscoverRunner({ zap: resolved(zap), katana: resolved(katana) })

    const out = await run(input)
    // GET /x (ZAP wins) + POST /x survive; katana's duplicate GET /x is dropped
    expect(out.urls).toEqual([url('/x', 'spider', 200, 'GET'), url('/x', 'katana', 405, 'POST')])
    expect(out.meta.merged).toEqual({ urlCount: 2, duplicates: 1, capped: 0 })
  })

  it('applies one overall cap across both sources', async () => {
    const zap = output(Array.from({ length: 400 }, (_, i) => url(`/z/${i}`, 'spider')))
    const katana = output(Array.from({ length: 400 }, (_, i) => url(`/k/${i}`, 'katana')))
    const run = createDiscoverRunner({ zap: resolved(zap), katana: resolved(katana) })

    const out = await run(input)

    expect(out.urls).toHaveLength(500)
    expect(out.urls.filter((u) => u.source === 'spider')).toHaveLength(400)
    expect(out.meta.merged).toEqual({ urlCount: 500, duplicates: 0, capped: 300 })
  })

  it('keeps the ZAP result and warns when katana fails', async () => {
    const zap = output([url('/', 'spider')], { meta: { nodeCount: 1, urlCount: 1 } })
    const run = createDiscoverRunner({
      zap: resolved(zap),
      katana: rejected(new EngineError('katana: failed to spawn /usr/local/bin/katana: ENOENT')),
    })

    const out = await run(input)

    expect(out.urls).toEqual([url('/', 'spider')])
    expect(out.warnings).toEqual([
      'katana crawl failed (ZAP results kept): katana: failed to spawn /usr/local/bin/katana: ENOENT',
    ])
    expect(out.meta).toEqual({
      nodeCount: 1,
      urlCount: 1,
      katana: { error: 'katana: failed to spawn /usr/local/bin/katana: ENOENT' },
    })
  })

  it('fails the discovery when ZAP fails, even if katana succeeded', async () => {
    const run = createDiscoverRunner({
      zap: rejected(new EngineError('discovery produced no site-tree.jsonl')),
      katana: resolved(output([url('/api/Feedbacks', 'katana')])),
    })
    await expect(run(input)).rejects.toThrow('discovery produced no site-tree.jsonl')
  })

  it('runs both sources against the same input concurrently', async () => {
    const seen: string[] = []
    let releaseZap!: () => void
    const zapGate = new Promise<void>((r) => (releaseZap = r))
    const run = createDiscoverRunner({
      zap: async (i) => {
        seen.push(`zap:${i.discoveryId}`)
        await zapGate
        return output([url('/', 'spider')])
      },
      katana: async (i) => {
        seen.push(`katana:${i.discoveryId}`)
        return output([url('/api/Feedbacks', 'katana')])
      },
    })
    const p = run(input)
    // katana was started before zap finished.
    await Promise.resolve()
    expect(seen).toEqual(['zap:disc-1', 'katana:disc-1'])
    releaseZap()
    expect((await p).urls).toHaveLength(2)
  })
})
