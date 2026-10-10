import type { EngineRunView, FindingView, HistoryPoint, ScanDetail } from '#shared/types/api'

/** Shared scan/engine/finding fixture builders for component and page specs
 * — kept here so EngineRunPanel.spec.ts and scans-id.spec.ts build the same
 * shapes rather than drifting apart. */

export function engineRunFixture(overrides: Partial<EngineRunView> = {}): EngineRunView {
  return {
    id: 'run-1',
    engine: 'nuclei',
    status: 'done',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    exitCode: 0,
    signal: null,
    counts: { critical: 1, high: 2, medium: 3, low: 4, info: 5 },
    meta: {},
    warnings: [],
    error: null,
    limits: {
      parts: [{ label: 'nuclei (SAKUDA_NUCLEI_MAX_MINUTES)', minutes: 60 }],
      totalMinutes: 60,
      estimated: false,
    },
    ...overrides,
  }
}

export function findingFixture(overrides: Partial<FindingView> = {}): FindingView {
  return {
    id: 'finding-1',
    engine: 'nuclei',
    ruleId: 'exposed-panel',
    name: 'Exposed admin panel',
    severity: 'high',
    url: 'https://example.com/admin',
    method: 'GET',
    param: null,
    evidence: null,
    description: null,
    solution: null,
    reference: null,
    fingerprint: 'fp-1',
    isNew: false,
    ...overrides,
  }
}

export function scanDetailFixture(overrides: Partial<ScanDetail> = {}): ScanDetail {
  return {
    id: 'scan-1',
    siteId: 'site-1',
    status: 'done',
    engines: ['nuclei'],
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    error: null,
    counts: { critical: 1, high: 2, medium: 3, low: 4, info: 5 },
    siteName: 'Example',
    siteSnapshot: {
      id: 'site-1',
      name: 'Example',
      frontBaseUrl: 'https://example.com',
      apiBaseUrl: null,
      nucleiPaths: '',
      openapiUrl: null,
      hasOpenapiJson: false,
      zapFeSeedPath: '/',
      discoverySeedPaths: '',
      crawlScopePaths: '',
      excludePaths: '',
      nucleiRateLimit: 50,
      nucleiMaxMinutes: null,
      nucleiConcurrency: null,
      zapApiMaxMinutes: 45,
      zapFeSpiderMaxMinutes: 5,
      nonLocalConfirmed: true,
      allowMutatingRequests: false,
      nucleiEnabledRiskTags: [],
      headerNames: [],
      browserStorageNames: [],
      requestShapes: {},
      requiresConfirmation: false,
    },
    engineRuns: [engineRunFixture()],
    findings: [findingFixture()],
    diff: null,
    now: '2026-01-01T00:05:00.000Z',
    ...overrides,
  }
}

export function historyPointFixture(overrides: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    scanId: 'scan-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    status: 'done',
    counts: { critical: 1, high: 2, medium: 3, low: 4, info: 5 },
    engines: { nuclei: { critical: 1, high: 2, medium: 3, low: 4, info: 5 } },
    diff: null,
    ...overrides,
  }
}
