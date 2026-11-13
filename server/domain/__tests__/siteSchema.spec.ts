import { describe, expect, it } from 'vitest'
import {
  OPENAPI_ALLOWED_ORIGINS_MAX,
  SiteInputSchema,
  SiteUpdateSchema,
} from '#shared/schemas/site'

const minimal = { name: 'Site', frontBaseUrl: 'http://localhost:3000' }

function issuesFor(input: unknown) {
  const result = SiteInputSchema.safeParse(input)
  if (result.success) return []
  return result.error.issues
}

describe('SiteInputSchema', () => {
  it('applies defaults for a minimal valid input', () => {
    const result = SiteInputSchema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toMatchObject({
      apiBaseUrl: null,
      nucleiPaths: '',
      openapiUrl: null,
      openapiJson: null,
      zapFeSeedPath: '/',
      discoverySeedPaths: '',
      excludePaths: '',
      nucleiRateLimit: 50,
      nucleiMaxMinutes: null,
      nucleiConcurrency: null,
      zapApiMaxMinutes: 45,
      zapFeSpiderMaxMinutes: 5,
      nonLocalConfirmed: false,
      allowMutatingRequests: false,
      nucleiEnabledRiskTags: [],
      nucleiTags: [],
      openapiAllowedOrigins: [],
    })
  })

  it('accepts nuclei limit overrides in range, and null to clear them (#10)', () => {
    const ok = SiteInputSchema.safeParse({
      ...minimal,
      nucleiMaxMinutes: 600,
      nucleiConcurrency: 1,
    })
    expect(ok.success && [ok.data.nucleiMaxMinutes, ok.data.nucleiConcurrency]).toEqual([600, 1])
    const cleared = SiteUpdateSchema.safeParse({
      ...minimal,
      nucleiMaxMinutes: null,
      nucleiConcurrency: null,
    })
    expect(cleared.success).toBe(true)
  })

  it.each([
    ['nucleiMaxMinutes', 0],
    ['nucleiMaxMinutes', -5],
    ['nucleiMaxMinutes', 601],
    ['nucleiMaxMinutes', 1.5],
    ['nucleiMaxMinutes', '60'],
    ['nucleiConcurrency', 0],
    ['nucleiConcurrency', 101],
    ['nucleiConcurrency', 'many'],
  ])('rejects %s = %j with an issue on that field (#10)', (field, value) => {
    const issues = issuesFor({ ...minimal, [field]: value })
    expect(issues.map((i) => i.path.join('.'))).toContain(field)
  })

  it('defaults nucleiEnabledRiskTags to [] and rejects an unknown risk tag', () => {
    const ok = SiteInputSchema.safeParse({ name: 's', frontBaseUrl: 'http://localhost:3000' })
    expect(ok.success && ok.data.nucleiEnabledRiskTags).toEqual([])
    const bad = SiteInputSchema.safeParse({
      name: 's',
      frontBaseUrl: 'http://localhost:3000',
      nucleiEnabledRiskTags: ['fuzz', 'nope'],
    })
    expect(bad.success).toBe(false)
  })

  it('defaults nucleiTags to [] (= all) and accepts the listed tags (#52)', () => {
    const ok = SiteInputSchema.safeParse(minimal)
    expect(ok.success && ok.data.nucleiTags).toEqual([])
    const picked = SiteInputSchema.safeParse({ ...minimal, nucleiTags: ['cve', 'exposure'] })
    expect(picked.success && picked.data.nucleiTags).toEqual(['cve', 'exposure'])
  })

  it.each([
    [['xss', 'tech'], 'nucleiTags.1', /unknown nuclei tag "tech"/],
    [['cve,xss'], 'nucleiTags.0', /unknown nuclei tag "cve,xss"/],
    [[42], 'nucleiTags.0', /unknown nuclei tag 42/],
    ['xss', 'nucleiTags', /./],
  ])('rejects nucleiTags = %j, naming the bad value (#52)', (value, path, message) => {
    const issues = issuesFor({ ...minimal, nucleiTags: value })
    const issue = issues.find((i) => i.path.join('.') === path)
    expect(issue?.message).toMatch(message)
  })

  it('normalizes openapiAllowedOrigins to origins and drops duplicates (#27)', () => {
    const ok = SiteInputSchema.safeParse({
      ...minimal,
      openapiAllowedOrigins: [
        'https://Docs.Example.com/',
        'https://docs.example.com:443',
        'http://cdn.example.org:8080',
      ],
    })
    expect(ok.success && ok.data.openapiAllowedOrigins).toEqual([
      'https://docs.example.com',
      'http://cdn.example.org:8080',
    ])
  })

  it.each([
    ['https://docs.example.com/openapi.json', /origin only/],
    ['https://docs.example.com?x=1', /origin only/],
    ['https://user:pw@docs.example.com', /origin only/],
    ['ftp://docs.example.com', /http\(s\)/],
    ['docs.example.com', /http\(s\)/],
  ])('rejects openapiAllowedOrigins entry %j (#27)', (value, message) => {
    const issue = issuesFor({ ...minimal, openapiAllowedOrigins: [value] }).find(
      (i) => i.path.join('.') === 'openapiAllowedOrigins.0',
    )
    expect(issue?.message).toMatch(message)
  })

  it('caps openapiAllowedOrigins at OPENAPI_ALLOWED_ORIGINS_MAX (#27)', () => {
    const origins = Array.from(
      { length: OPENAPI_ALLOWED_ORIGINS_MAX + 1 },
      (_, i) => `https://h${i}.example.com`,
    )
    const issues = issuesFor({ ...minimal, openapiAllowedOrigins: origins })
    expect(issues.some((i) => i.path.join('.') === 'openapiAllowedOrigins')).toBe(true)
  })

  it('maps empty string to null for optional URLs', () => {
    const result = SiteInputSchema.safeParse({ ...minimal, apiBaseUrl: '', openapiUrl: '' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.apiBaseUrl).toBeNull()
    expect(result.data.openapiUrl).toBeNull()
  })

  it('strips trailing slash from base URLs', () => {
    const result = SiteInputSchema.safeParse({
      ...minimal,
      frontBaseUrl: 'http://localhost:3000/',
      apiBaseUrl: 'http://localhost:8080/',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.frontBaseUrl).toBe('http://localhost:3000')
    expect(result.data.apiBaseUrl).toBe('http://localhost:8080')
  })

  it('validates crawlScopePaths per line (path prefixes only) and defaults it to empty', () => {
    const ok = SiteInputSchema.safeParse({ ...minimal, crawlScopePaths: '# api\n/rest/\n/app' })
    expect(ok.success && ok.data.crawlScopePaths).toBe('# api\n/rest/\n/app')
    expect(SiteInputSchema.safeParse(minimal).success && 'ok').toBe('ok')
    const issues = issuesFor({ ...minimal, crawlScopePaths: '/rest\nrest\n/search?q=a\n/#/app' })
    expect(
      issues.filter((i) => i.path.join('.') === 'crawlScopePaths').map((i) => i.message),
    ).toEqual([
      expect.stringContaining('line 2'),
      expect.stringContaining('line 3'),
      expect.stringContaining('line 4'),
    ])
  })

  it('requires apiBaseUrl when nucleiPaths has an "api:" line', () => {
    const issues = issuesFor({ ...minimal, nucleiPaths: 'api:/v1/users' })
    expect(issues.some((i) => i.path.join('.') === 'apiBaseUrl')).toBe(true)
  })

  it('rejects both openapiUrl and openapiJson set', () => {
    const issues = issuesFor({
      ...minimal,
      openapiUrl: 'http://localhost:3000/openapi.json',
      openapiJson: '{"a":1}',
    })
    expect(issues.some((i) => i.path.join('.') === 'openapiJson')).toBe(true)
  })

  it('rejects invalid openapiJson', () => {
    const issues = issuesFor({ ...minimal, openapiJson: 'not json' })
    expect(issues.some((i) => i.path.join('.') === 'openapiJson')).toBe(true)
  })

  it('requires nonLocalConfirmed when frontBaseUrl is non-local', () => {
    const issues = issuesFor({ ...minimal, frontBaseUrl: 'https://app.example.com' })
    const issue = issues.find((i) => i.path.join('.') === 'nonLocalConfirmed')
    expect(issue?.message).toContain('nonLocalConfirmed')
  })

  it('requires nonLocalConfirmed when only openapiUrl is non-local (I2)', () => {
    const issues = issuesFor({
      ...minimal,
      openapiUrl: 'https://internal.corp/openapi.json',
    })
    const issue = issues.find((i) => i.path.join('.') === 'nonLocalConfirmed')
    expect(issue?.message).toContain('nonLocalConfirmed')
  })

  it('accepts a non-local frontBaseUrl when nonLocalConfirmed is true', () => {
    const result = SiteInputSchema.safeParse({
      ...minimal,
      frontBaseUrl: 'https://app.example.com',
      nonLocalConfirmed: true,
      allowMutatingRequests: false,
      nucleiEnabledRiskTags: [],
      nucleiTags: [],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a bad nucleiPaths line', () => {
    const issues = issuesFor({ ...minimal, nucleiPaths: 'not-a-path' })
    expect(issues.some((i) => i.path.join('.') === 'nucleiPaths')).toBe(true)
  })

  it('validates headers', () => {
    const issues = issuesFor({ ...minimal, headers: [{ name: 'X:Y', value: 'a' }] })
    expect(issues.some((i) => i.path[0] === 'headers')).toBe(true)
  })

  it('accepts valid headers', () => {
    const result = SiteInputSchema.safeParse({
      ...minimal,
      headers: [{ name: 'Cookie', value: 'a=b' }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects duplicate header names (exact, case-sensitive match)', () => {
    const dup = [
      { name: 'Cookie', value: 'a' },
      { name: 'Cookie', value: 'b' },
    ]
    expect(issuesFor({ ...minimal, headers: dup }).some((i) => i.path[0] === 'headers')).toBe(true)
    expect(SiteUpdateSchema.safeParse({ ...minimal, headers: dup }).success).toBe(false)
    // different case = different header as far as the merge is concerned
    const ok = SiteUpdateSchema.safeParse({
      ...minimal,
      headers: [{ name: 'cookie' }, { name: 'Cookie', value: 'b' }],
    })
    expect(ok.success).toBe(true)
  })

  it('SiteUpdateSchema lets a header row omit its value; SiteInputSchema still requires it', () => {
    const rows = [{ name: 'Authorization' }, { name: 'X-Api-Key', value: 'k' }]
    const update = SiteUpdateSchema.safeParse({ ...minimal, headers: rows })
    expect(update.success).toBe(true)
    expect(update.data?.headers).toEqual(rows)
    const create = SiteInputSchema.safeParse({ ...minimal, headers: rows })
    expect(create.success).toBe(false)
    expect(create.error?.issues.some((i) => i.path.join('.') === 'headers.0.value')).toBe(true)
  })

  it('SiteUpdateSchema applies the same cross-field rules as SiteInputSchema', () => {
    const r = SiteUpdateSchema.safeParse({ ...minimal, nucleiPaths: 'api:/x' })
    expect(r.success).toBe(false)
    expect(r.error?.issues.some((i) => i.path.join('.') === 'apiBaseUrl')).toBe(true)
  })

  it('requires zapFeSeedPath to start with "/"', () => {
    const issues = issuesFor({ ...minimal, zapFeSeedPath: 'no-slash' })
    expect(issues.some((i) => i.path.join('.') === 'zapFeSeedPath')).toBe(true)
  })

  it('defaults discoverySeedPaths to empty and rejects lines that are not paths', () => {
    const ok = SiteInputSchema.safeParse({ ...minimal, discoverySeedPaths: '/\n/#/basket\n# c' })
    expect(ok.success).toBe(true)
    expect(
      SiteInputSchema.safeParse(minimal).success &&
        SiteInputSchema.parse(minimal).discoverySeedPaths,
    ).toBe('')
    const issues = issuesFor({ ...minimal, discoverySeedPaths: '/ok\nhttp://x.example/' })
    expect(issues.map((i) => i.path.join('.'))).toEqual(['discoverySeedPaths'])
    expect(issues[0]?.message).toContain('line 2')
  })

  it('accepts browserStorage items and enforces cookie naming rules', () => {
    expect(
      SiteInputSchema.safeParse({
        ...minimal,
        browserStorage: [
          { kind: 'localStorage', name: 'token', value: 'abc' },
          { kind: 'cookie', name: 'token', value: 'abc' },
        ],
      }).success,
    ).toBe(true)
    const issues = issuesFor({
      ...minimal,
      browserStorage: [{ kind: 'cookie', name: 'bad name', value: 'x;y' }],
    })
    expect(issues.map((i) => i.path.join('.'))).toEqual([
      'browserStorage.0.name',
      'browserStorage.0.value',
    ])
    expect(
      issuesFor({ ...minimal, browserStorage: [{ kind: 'indexedDB', name: 'a', value: 'b' }] }),
    ).not.toHaveLength(0)
  })

  it('rejects duplicate browser storage (kind, name) pairs but allows same name across kinds', () => {
    const dup = [
      { kind: 'localStorage', name: 'token', value: 'a' },
      { kind: 'localStorage', name: 'token', value: 'b' },
    ]
    expect(
      issuesFor({ ...minimal, browserStorage: dup }).some((i) => i.path[0] === 'browserStorage'),
    ).toBe(true)
    expect(SiteUpdateSchema.safeParse({ ...minimal, browserStorage: dup }).success).toBe(false)
    // same name, different kind = distinct items
    const ok = SiteUpdateSchema.safeParse({
      ...minimal,
      browserStorage: [
        { kind: 'localStorage', name: 'token' },
        { kind: 'sessionStorage', name: 'token', value: 'b' },
      ],
    })
    expect(ok.success).toBe(true)
  })

  it('SiteUpdateSchema lets a browser storage row omit its value; SiteInputSchema still requires it', () => {
    const rows = [
      { kind: 'localStorage', name: 'token' },
      { kind: 'cookie', name: 'sid', value: 'x' },
    ]
    const update = SiteUpdateSchema.safeParse({ ...minimal, browserStorage: rows })
    expect(update.success).toBe(true)
    expect(update.data?.browserStorage).toEqual(rows)
    const create = SiteInputSchema.safeParse({ ...minimal, browserStorage: rows })
    expect(create.success).toBe(false)
    expect(create.error?.issues.some((i) => i.path.join('.') === 'browserStorage.0.value')).toBe(
      true,
    )
  })
})

describe('authCheckPath (#74)', () => {
  it('defaults to null and turns an empty string into null', () => {
    expect(SiteInputSchema.parse(minimal).authCheckPath).toBeNull()
    expect(SiteInputSchema.parse({ ...minimal, authCheckPath: '  ' }).authCheckPath).toBeNull()
  })

  it('accepts a front path and, with an API base URL, an api: path', () => {
    expect(SiteInputSchema.parse({ ...minimal, authCheckPath: ' /account ' }).authCheckPath).toBe(
      '/account',
    )
    expect(
      SiteInputSchema.parse({
        ...minimal,
        apiBaseUrl: 'http://localhost:3001',
        authCheckPath: 'api:/me',
      }).authCheckPath,
    ).toBe('api:/me')
  })

  it('rejects a full URL, which could point the check off the site', () => {
    expect(
      issuesFor({ ...minimal, authCheckPath: 'https://evil.example/me' }).map((i) => i.path),
    ).toEqual([['authCheckPath']])
  })

  it('requires an API base URL for an api: path', () => {
    expect(issuesFor({ ...minimal, authCheckPath: 'api:/me' }).map((i) => i.path)).toEqual([
      ['apiBaseUrl'],
    ])
  })
})
