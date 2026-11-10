import { describe, expect, it } from 'vitest'
import { buildScanMarkdown } from '../markdownReport'
import type { EngineRunView, FindingView, ScanDetail, SiteSnapshot } from '#shared/types/api'

const siteSnapshot: SiteSnapshot = {
  id: 'site-1',
  name: 'shop',
  frontBaseUrl: 'https://shop.example.com',
  apiBaseUrl: 'https://api.shop.example.com',
  nucleiPaths: '/',
  openapiUrl: null,
  hasOpenapiJson: false,
  zapFeSeedPath: '/',
  discoverySeedPaths: '',
  crawlScopePaths: '',
  excludePaths: '',
  nucleiRateLimit: 50,
  zapApiMaxMinutes: 10,
  zapFeSpiderMaxMinutes: 5,
  nonLocalConfirmed: true,
  allowMutatingRequests: false,
  nucleiEnabledRiskTags: [],
  nucleiTags: [],
  headerNames: ['Authorization'],
  browserStorageNames: [],
  requiresConfirmation: false,
}

// Evidence/description/solution/reference deliberately carry pipes, backticks
// and newlines to exercise the neutralisation rules.
const nucleiFinding: FindingView = {
  id: 'f-1',
  engine: 'nuclei',
  ruleId: 'exposed-panel',
  name: 'Exposed Admin Panel',
  severity: 'high',
  url: 'https://shop.example.com/admin',
  method: 'GET',
  param: null,
  evidence: 'HTTP/1.1 200 OK\nServer: `nginx` | proxy',
  description: 'An admin panel is exposed without authentication.\nSecond line ignored.',
  solution: 'Restrict access to the admin panel.\nAdd auth.',
  reference:
    'https://example.com/ref1\nhttps://example.com/ref2\nhttps://example.com/ref3\nhttps://example.com/ref4',
  fingerprint: 'fp-1',
  isNew: true,
}

const nucleiRun: EngineRunView = {
  id: 'run-1',
  engine: 'nuclei',
  status: 'done',
  startedAt: '2026-08-30T01:00:00.000Z',
  finishedAt: '2026-08-30T01:05:00.000Z',
  exitCode: 0,
  signal: null,
  counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  meta: {
    urlCount: 12,
    excludedUrls: ['/health'],
    tags: ['cve', 'exposure'],
    rateLimit: 50,
    concurrency: 25,
    templatesDir: '/opt/nuclei-templates',
    stats: {
      duration: '5m0s',
      errors: '3',
      hosts: '1',
      matched: '1',
      requests: '62854',
      rps: '209.5',
      templates: '4500',
      total: '62854',
    },
    durationSec: 300,
    timedOut: false,
  },
  warnings: [],
  error: null,
}

const zapFeRun: EngineRunView = {
  id: 'run-2',
  engine: 'zap-fe',
  status: 'done',
  startedAt: '2026-08-30T01:05:00.000Z',
  finishedAt: '2026-08-30T01:10:00.000Z',
  exitCode: 0,
  signal: null,
  counts: { critical: 0, high: 0, medium: 0, low: 2, info: 1 },
  meta: {
    zapVersion: '2.15.0',
    seedUrls: ['https://shop.example.com/', 'https://shop.example.com/#/basket'],
    spider: 'traditional + ajax',
    spiderMaxMinutes: 5,
    reachedUrlCount: 3,
    reachedUrls: [
      'https://shop.example.com/',
      'https://shop.example.com/cart',
      'https://shop.example.com/checkout',
    ],
    authFailureCount: 0,
    alertCounts: { critical: 0, high: 0, medium: 0, low: 2, info: 1 },
    excludeRegexes: ['^.*\\.png$'],
    durationSec: 300,
    timedOut: false,
  },
  warnings: [
    'seed path / was not among reached URLs — the spider may not have been authenticated; check the site headers',
  ],
  error: null,
}

const zapApiRun: EngineRunView = {
  id: 'run-3',
  engine: 'zap-api',
  status: 'failed',
  startedAt: '2026-08-30T01:10:00.000Z',
  finishedAt: '2026-08-30T01:11:00.000Z',
  exitCode: 1,
  signal: null,
  counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  meta: {
    zapVersion: '2.15.0',
    targetUrl: 'https://api.shop.example.com',
    openapiSource: 'url',
    maxScanMinutes: 10,
    authFailureCount: 0,
    alertCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    reachedUrlCount: 0,
    excludeRegexes: [],
    durationSec: 60,
    timedOut: false,
  },
  warnings: [],
  error: 'zap-api produced no report.json (exit 1, signal none); see /tmp/stdout.log',
}

const detail: ScanDetail = {
  id: 'scan-12345678',
  siteId: 'site-1',
  status: 'done',
  engines: ['nuclei', 'zap-fe', 'zap-api'],
  createdAt: '2026-08-30T00:55:00.000Z',
  startedAt: '2026-08-30T01:00:00.000Z',
  finishedAt: '2026-08-30T01:11:00.000Z',
  error: null,
  counts: { critical: 0, high: 1, medium: 0, low: 2, info: 1 },
  siteName: 'shop',
  siteSnapshot,
  engineRuns: [nucleiRun, zapFeRun, zapApiRun],
  findings: [nucleiFinding],
  diff: {
    previousScanId: 'scan-prev',
    newCount: 1,
    persistingCount: 0,
    resolved: [],
  },
}

describe('buildScanMarkdown', () => {
  const md = buildScanMarkdown(detail)
  const lines = md.split('\n')

  it('titles with site name and finishedAt date', () => {
    expect(lines).toContain('# sakuda Scan Report — shop — 2026-08-30')
  })

  it('orders top-level sections correctly', () => {
    const idx = (needle: string) => md.indexOf(needle)
    expect(idx('# sakuda Scan Report')).toBeGreaterThanOrEqual(0)
    expect(idx('## Scan metadata')).toBeGreaterThan(idx('# sakuda Scan Report'))
    expect(idx('## Summary')).toBeGreaterThan(idx('## Scan metadata'))
    expect(idx('## Changes vs previous scan')).toBeGreaterThan(idx('## Summary'))
    expect(idx('## nuclei')).toBeGreaterThan(idx('## Changes vs previous scan'))
    expect(idx('## zap-fe')).toBeGreaterThan(idx('## nuclei'))
    expect(idx('## zap-api')).toBeGreaterThan(idx('## zap-fe'))
  })

  it('renders scan metadata with front/api base URLs and scan id', () => {
    expect(md).toContain('| Site | shop |')
    expect(md).toContain('| Front base URL | `https://shop.example.com` |')
    expect(md).toContain('| API base URL | `https://api.shop.example.com` |')
    expect(md).toContain('| Scan id | `scan-12345678` |')
    // zap-fe meta: the crawl starts are a list (one Ajax spider run each)
    expect(md).toContain(
      '| Seed URLs | `https://shop.example.com/`, `https://shop.example.com/#/basket` |',
    )
  })

  it('renders the summary table with a row per engine run plus a total row', () => {
    expect(lines).toContain('| Engine | Critical | High | Medium | Low | Info |')
    expect(lines).toContain('| nuclei | 0 | 1 | 0 | 0 | 0 |')
    expect(lines).toContain('| zap-fe | 0 | 0 | 0 | 2 | 1 |')
    expect(lines).toContain('| zap-api | 0 | 0 | 0 | 0 | 0 |')
    expect(lines).toContain('| **Total** | 0 | 1 | 0 | 2 | 1 |')
  })

  it('renders the diff section with counts', () => {
    expect(lines).toContain('New: 1')
    expect(lines).toContain('Persisting: 0')
    expect(lines).toContain('Resolved: 0')
  })

  it('shows "no previous scan" when diff is null', () => {
    const noDiff = buildScanMarkdown({ ...detail, diff: null })
    expect(noDiff).toContain('No previous scan to compare against.')
  })

  it('lists resolved findings when present', () => {
    const resolvedFinding: FindingView = {
      ...nucleiFinding,
      id: 'f-resolved',
      ruleId: 'old-rule',
      name: 'Old Finding',
      url: 'https://shop.example.com/old',
      isNew: false,
    }
    const withResolved = buildScanMarkdown({
      ...detail,
      diff: {
        previousScanId: 'scan-prev',
        newCount: 0,
        persistingCount: 0,
        resolved: [resolvedFinding],
      },
    })
    expect(withResolved).toContain('old-rule — Old Finding — `https://shop.example.com/old`')
  })

  it('renders nuclei-specific metadata from meta.stats', () => {
    expect(lines).toContain('| Requests sent | 62854 |')
    expect(lines).toContain('| Templates scanned | 4500 |')
    expect(lines).toContain('| Errors | 3 |')
    expect(lines).toContain('| Target URLs | 12 |')
    expect(lines).toContain('| Rate limit | 50 req/s |')
  })

  it('renders the nuclei Tags row from the real string[] meta shape', () => {
    expect(lines).toContain('| Tags | `cve,exposure` |')
  })

  it('omits the Active checks row when meta.activeScan is false or absent', () => {
    expect(lines.some((l) => l.startsWith('| Active checks'))).toBe(false)
  })

  it('renders the Risk groups row when meta.riskTags is non-empty', () => {
    const md = buildScanMarkdown({
      ...detail,
      engineRuns: [
        {
          ...nucleiRun,
          meta: { ...nucleiRun.meta, activeScan: true, riskTags: ['fuzz', 'intrusive'] },
        },
      ],
    })
    expect(md.split('\n')).toContain('| Risk groups | `fuzz,intrusive` |')
  })

  it('renders the Active checks (DAST) and fuzzable-URL rows when meta.activeScan is true', () => {
    const md = buildScanMarkdown({
      ...detail,
      engineRuns: [
        { ...nucleiRun, meta: { ...nucleiRun.meta, activeScan: true, parameterizedUrlCount: 3 } },
      ],
    })
    expect(md.split('\n')).toContain('| Active checks (DAST) | Yes |')
    expect(md.split('\n')).toContain('| Fuzzable URLs (with query params) | 3 |')
  })

  it('renders the zap-fe Active scan row with its cap only when meta.activeScan is true', () => {
    // the shared fixture has no activeScan meta at all → no row
    expect(lines.some((l) => l.startsWith('| Active scan'))).toBe(false)
    const md = buildScanMarkdown({
      ...detail,
      engineRuns: [
        { ...zapFeRun, meta: { ...zapFeRun.meta, activeScan: true, activeScanMaxMinutes: 45 } },
      ],
    })
    expect(md.split('\n')).toContain('| Active scan | Yes (max 45 min) |')
  })

  it('renders findings grouped by severity with a NEW marker', () => {
    expect(lines).toContain('### high')
    expect(lines).toContain('#### exposed-panel — Exposed Admin Panel **NEW**')
    expect(lines).toContain('- **URL**: `GET https://shop.example.com/admin`')
  })

  it('neutralises pipes, backticks and newlines in finding fields', () => {
    expect(lines).toContain('- **Evidence**: `HTTP/1.1 200 OK Server:  nginx  \\| proxy`')
    expect(md).not.toMatch(/```[\s\S]*nginx`[\s\S]*```/)
  })

  it('truncates evidence to 120 characters', () => {
    const longEvidence = 'x'.repeat(200)
    const withLongEvidence = buildScanMarkdown({
      ...detail,
      findings: [{ ...nucleiFinding, evidence: longEvidence }],
    })
    expect(withLongEvidence).toContain(`- **Evidence**: \`${'x'.repeat(120)}\`…`)
  })

  it('renders description first line, solution and up to 3 reference lines', () => {
    expect(lines).toContain('- An admin panel is exposed without authentication.')
    expect(lines).toContain('- **Solution**: Restrict access to the admin panel.')
    expect(lines).toContain(
      '- Refs: https://example.com/ref1, https://example.com/ref2, https://example.com/ref3',
    )
  })

  it('renders warnings as blockquote lines', () => {
    expect(lines).toContain(
      '> Warning: seed path / was not among reached URLs — the spider may not have been authenticated; check the site headers',
    )
  })

  it('lists reached URLs for zap-fe capped at 60', () => {
    expect(lines).toContain('### Reached URLs')
    expect(lines).toContain('- `https://shop.example.com/`')
    expect(lines).toContain('- `https://shop.example.com/cart`')
  })

  it('caps reached URLs at 60 with a "more" marker', () => {
    const manyUrls = Array.from({ length: 75 }, (_, i) => `https://shop.example.com/p${i}`)
    const withMany = buildScanMarkdown({
      ...detail,
      engineRuns: [{ ...zapFeRun, meta: { ...zapFeRun.meta, reachedUrls: manyUrls } }],
    })
    const withManyLines = withMany.split('\n')
    expect(withManyLines.filter((l) => l.startsWith('- `https://shop.example.com/p')).length).toBe(
      60,
    )
    expect(withMany).toContain('- … 15 more')
  })

  it('marks a failed engine run with a status line and fenced error block', () => {
    expect(md).toContain('Status: failed')
    expect(md).toContain(
      '```\nzap-api produced no report.json (exit 1, signal none); see /tmp/stdout.log\n```',
    )
  })

  it('preserves newlines in a multi-line engine error (e.g. an appended runbook)', () => {
    const withRunbookError = buildScanMarkdown({
      ...detail,
      engineRuns: [{ ...zapApiRun, error: 'boom\nRunbook: do X' }],
    })
    expect(withRunbookError).toContain('```\nboom\nRunbook: do X\n```')
    const errorLines = withRunbookError.split('\n')
    expect(errorLines).toContain('boom')
    expect(errorLines).toContain('Runbook: do X')
  })
})
