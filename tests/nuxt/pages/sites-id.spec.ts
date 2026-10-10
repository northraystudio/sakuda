import { beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import SiteDetailPage from '~/pages/sites/[id]/index.vue'
import type { SitePublic, TargetSummary } from '#shared/types/api'

function siteFixture(overrides: Partial<SitePublic> = {}): SitePublic {
  return {
    id: 'site-1',
    name: 'Example Shop',
    frontBaseUrl: 'https://shop.example.com',
    apiBaseUrl: null,
    nucleiPaths: '',
    openapiUrl: null,
    openapiJson: null,
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const ROUTE = '/sites/site-1'

const emptyEngine = { available: true, targets: [], skipped: [] }
function summaryFixture(overrides: Partial<TargetSummary> = {}): TargetSummary {
  return {
    configured: false,
    activeChecks: false,
    common: [],
    excludedCount: 0,
    engines: {
      nuclei: { ...emptyEngine, targets: [{ method: 'GET', base: 'front', path: '/' }] },
      'zap-fe': emptyEngine,
      'zap-api': { ...emptyEngine, available: false },
      dalfox: { ...emptyEngine, available: false },
    },
    zapApiSource: 'none',
    ...overrides,
  }
}

function registerSite(site: SitePublic = siteFixture(), summary = summaryFixture()) {
  registerEndpoint(`/api/sites/${site.id}`, () => site)
  registerEndpoint(`/api/sites/${site.id}/scans`, () => [])
  registerEndpoint(`/api/sites/${site.id}/history`, () => [])
  registerEndpoint(`/api/sites/${site.id}/targets`, () => summary)
}

describe('pages/sites/[id] — Start scan engine defaults', () => {
  beforeEach(() => {
    clearNuxtData()
  })

  it('has the nuclei engine checked and enabled on first render', async () => {
    registerSite()
    const wrapper = await mountSuspended(SiteDetailPage, { route: ROUTE })

    const nuclei = wrapper.get('[data-testid="engine-nuclei"]').element as HTMLInputElement
    expect(nuclei.checked).toBe(true)
    expect(nuclei.disabled).toBe(false)
  })

  it('keeps the no-saved-paths hint accurate — base URL only, no zap-fe wording', async () => {
    registerSite(siteFixture({ nucleiPaths: '' }))
    const wrapper = await mountSuspended(SiteDetailPage, { route: ROUTE })

    // The nuclei hint (shown only when no target paths are saved) must describe
    // the real post-#2 behavior — base URL only — and must NOT resurrect the
    // stale "+ zap-fe reached URLs" wording (that in-scan merge was removed).
    const hint = wrapper
      .findAll('p')
      .map((p) => p.text())
      .find((t) => t.includes('No target paths saved'))
    expect(hint).toBeDefined()
    expect(hint).toContain('base URL only')
    expect(hint).not.toMatch(/reached/i)
  })

  it('shows the saved-target count and an Edit link, but no discovery/save UI (that lives in Edit)', async () => {
    registerSite(siteFixture({ nucleiPaths: '/\n/login\n' }))
    const wrapper = await mountSuspended(SiteDetailPage, { route: ROUTE })

    expect(wrapper.find('[data-testid="saved-target-count"]').text()).toContain(
      '2 saved target paths',
    )
    expect(wrapper.find('[data-testid="discovery-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="start-discovery"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="save-targets"]').exists()).toBe(false)
  })

  it('shows the saved list and a per-engine read-only view: counts, lines, availability', async () => {
    const root = { method: 'GET' as const, base: 'front' as const, path: '/' }
    const login = { method: 'POST' as const, base: 'front' as const, path: '/rest/user/login' }
    const hash = { method: 'GET' as const, base: 'front' as const, path: '/#/search?q=' }
    registerSite(
      siteFixture({ nucleiPaths: '/\nPOST /rest/user/login\n/#/search?q=\n/logout\n' }),
      summaryFixture({
        configured: true,
        common: [root, login, hash],
        excludedCount: 1,
        engines: {
          nuclei: { available: true, targets: [root], skipped: [login, hash] },
          'zap-fe': { available: true, targets: [root], skipped: [login, hash] },
          'zap-api': { available: false, targets: [], skipped: [root, login, hash] },
          dalfox: { available: false, targets: [], skipped: [root, login, hash] },
        },
      }),
    )
    const wrapper = await mountSuspended(SiteDetailPage, { route: ROUTE })

    // collapsed like the engine rows: a count in the summary, the lines inside
    const details = wrapper.find('[data-testid="common-targets-details"]')
    expect(details.find('summary').text()).toBe('3 saved lines')
    const common = details.findAll('[data-testid="common-targets"] li').map((li) => li.text())
    expect(common).toEqual(['/', 'POST /rest/user/login', '/#/search?q='])
    expect(wrapper.find('[data-testid="excluded-target-count"]').text()).toContain('1 line dropped')
    const nuclei = wrapper.find('[data-testid="engine-targets-nuclei"]')
    expect(nuclei.text()).toContain('Nuclei')
    expect(nuclei.findAll('summary').map((s) => s.text())).toEqual(['1', '2'])
    expect(nuclei.findAll('details li').map((li) => li.text())).toEqual([
      '/',
      'POST /rest/user/login',
      '/#/search?q=',
    ])
    expect(nuclei.text()).not.toContain('unavailable')
    const dalfox = wrapper.find('[data-testid="engine-targets-dalfox"]')
    expect(dalfox.text()).toContain('unavailable')
    expect(dalfox.text()).toContain('active checks')
    // read-only: nothing here edits the list
    expect(wrapper.find('[data-testid="remove-target"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="save-targets"]').exists()).toBe(false)
  })
})
