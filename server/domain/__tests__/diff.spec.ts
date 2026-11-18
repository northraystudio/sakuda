import { describe, expect, it } from 'vitest'
import {
  buildReachRecord,
  classifyGoneFinding,
  diffFingerprints,
  pickEngineBaselines,
  reachKey,
  splitGoneFindings,
  type ScanCoverage,
} from '../diff'
import type { Engine } from '#shared/types/api'

describe('diffFingerprints', () => {
  it('computes new/persisting/resolved counts over unique fingerprints', () => {
    expect(diffFingerprints(['a', 'b'], ['b', 'c', 'c'])).toEqual({
      new: 1,
      persisting: 1,
      resolved: 1,
      suppressed: 0,
    })
  })

  it('treats an empty previous set as all-new with nothing resolved', () => {
    expect(diffFingerprints([], ['a', 'b'])).toEqual({
      new: 2,
      persisting: 0,
      resolved: 0,
      suppressed: 0,
    })
  })

  it('treats an empty current set as everything resolved with nothing new', () => {
    expect(diffFingerprints(['a', 'b'], [])).toEqual({
      new: 0,
      persisting: 0,
      resolved: 2,
      suppressed: 0,
    })
  })

  it('returns all zero for two empty sets', () => {
    expect(diffFingerprints([], [])).toEqual({ new: 0, persisting: 0, resolved: 0, suppressed: 0 })
  })

  it('counts a would-be-new suppressed fingerprint as suppressed, not new', () => {
    expect(diffFingerprints(['a', 'b'], ['b', 'c', 'd'], new Set(['c', 'b']))).toEqual({
      new: 1,
      persisting: 1,
      resolved: 1,
      suppressed: 1,
    })
  })
})

const coverage = (
  doneEngines: Engine[],
  zapFeReach?: { urls: string[]; truncated?: boolean } | null,
): ScanCoverage => ({
  doneEngines: new Set(doneEngines),
  reach:
    zapFeReach === undefined
      ? new Map()
      : new Map([
          [
            'zap-fe' as Engine,
            zapFeReach && {
              urls: new Set(zapFeReach.urls),
              truncated: zapFeReach.truncated ?? false,
            },
          ],
        ]),
})

describe('reachKey', () => {
  it('keeps scheme, host and path only, and drops one trailing slash', () => {
    expect(reachKey('http://shop.test/dash/?token=secret#top')).toBe('http://shop.test/dash')
    expect(reachKey('http://shop.test/')).toBe('http://shop.test/')
    expect(reachKey('not a url')).toBe('not a url')
  })
})

describe('classifyGoneFinding (#89)', () => {
  const sitemap = { engine: 'zap-fe' as const, url: 'http://shop.test/sitemap.xml' }

  it('is unverified when the finding’s engine did not finish in this scan', () => {
    const finding = { engine: 'zap-api' as const, url: 'http://shop.test/api/x' }
    expect(classifyGoneFinding(finding, coverage(['zap-fe'], { urls: [] }))).toBe('engine-not-run')
  })

  it('is resolved when the engine finished and is not judged by URL', () => {
    const finding = { engine: 'nuclei' as const, url: 'http://shop.test/gone' }
    expect(classifyGoneFinding(finding, coverage(['nuclei']))).toBe('resolved')
  })

  it('is resolved when the engine requested the finding’s URL again (query ignored)', () => {
    const reach = { urls: ['http://shop.test/sitemap.xml'] }
    expect(
      classifyGoneFinding({ ...sitemap, url: `${sitemap.url}?v=2` }, coverage(['zap-fe'], reach)),
    ).toBe('resolved')
  })

  it('is unverified when the engine ran but did not request the finding’s URL', () => {
    const reach = { urls: ['http://shop.test/'] }
    expect(classifyGoneFinding(sitemap, coverage(['zap-fe'], reach))).toBe('url-not-reached')
  })

  it('is unverified (unknown) when the record is missing, or cut short and lacks the URL', () => {
    expect(classifyGoneFinding(sitemap, coverage(['zap-fe'], null))).toBe('reach-unknown')
    const cut = { urls: ['http://shop.test/'], truncated: true }
    expect(classifyGoneFinding(sitemap, coverage(['zap-fe'], cut))).toBe('reach-unknown')
    expect(
      classifyGoneFinding({ ...sitemap, url: 'http://shop.test/' }, coverage(['zap-fe'], cut)),
    ).toBe('resolved')
  })
})

describe('splitGoneFindings (#89)', () => {
  it('splits what is gone into resolved and unverified, once per fingerprint, skipping what persists', () => {
    const previous = [
      { engine: 'zap-fe' as const, url: 'http://shop.test/', fingerprint: 'fe-fixed' },
      { engine: 'zap-fe' as const, url: 'http://shop.test/', fingerprint: 'fe-fixed' },
      { engine: 'zap-fe' as const, url: 'http://shop.test/', fingerprint: 'fe-still' },
      { engine: 'zap-fe' as const, url: 'http://shop.test/sitemap.xml', fingerprint: 'fe-unseen' },
      { engine: 'zap-api' as const, url: 'http://shop.test/api/x', fingerprint: 'api-nosql' },
    ]
    const out = splitGoneFindings(
      previous,
      new Set(['fe-still']),
      coverage(['zap-fe'], { urls: ['http://shop.test/'] }),
    )
    expect(out.resolved.map((f) => f.fingerprint)).toEqual(['fe-fixed'])
    expect(out.unverified.map((u) => [u.finding.fingerprint, u.reason])).toEqual([
      ['fe-unseen', 'url-not-reached'],
      ['api-nosql', 'engine-not-run'],
    ])
  })
})

describe('buildReachRecord', () => {
  it('dedupes on the reach key and flags a record cut at the cap', () => {
    const urls = ['http://shop.test/a?x=1', 'http://shop.test/a?x=2', 'http://shop.test/b/']
    expect(buildReachRecord(urls)).toEqual({
      urls: ['http://shop.test/a', 'http://shop.test/b'],
      truncated: false,
    })
    expect(buildReachRecord(urls, 1)).toEqual({ urls: ['http://shop.test/a'], truncated: true })
  })
})

describe('pickEngineBaselines (#90)', () => {
  it('picks, per engine, the newest earlier scan in which that engine finished', () => {
    const baselines = pickEngineBaselines([
      { scanId: 'scan-3', doneEngines: ['zap-fe'] },
      { scanId: 'scan-2', doneEngines: ['zap-fe', 'zap-api'] },
      { scanId: 'scan-1', doneEngines: ['zap-api', 'nuclei'] },
    ])
    expect(Object.fromEntries(baselines)).toEqual({
      'zap-fe': 'scan-3',
      'zap-api': 'scan-2',
      nuclei: 'scan-1',
    })
  })

  it('has no entry for an engine that never finished, and none at all without earlier scans', () => {
    expect(pickEngineBaselines([{ scanId: 'scan-1', doneEngines: [] }]).size).toBe(0)
    expect(pickEngineBaselines([]).size).toBe(0)
    expect(pickEngineBaselines([{ scanId: 'scan-1', doneEngines: ['nuclei'] }]).has('dalfox')).toBe(
      false,
    )
  })
})
