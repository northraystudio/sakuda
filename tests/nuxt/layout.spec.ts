import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import DefaultLayout from '~/layouts/default.vue'
import type { SiteListItem } from '#shared/types/api'

function siteFixture(id: string, name: string): SiteListItem {
  return {
    id,
    name,
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
    lastScan: null,
  }
}

const h = vi.hoisted(() => ({
  navigateToMock: vi.fn(),
  routeRef: { value: { path: '/', params: {} as Record<string, string> } },
  activeRef: { value: null as string | null },
}))
mockNuxtImport('useRoute', () => () => h.routeRef.value)
mockNuxtImport('navigateTo', () => h.navigateToMock)
mockNuxtImport('useActiveSiteId', () => () => h.activeRef)

function registerSites(sites: SiteListItem[]) {
  registerEndpoint('/api/sites', () => sites)
}

const TWO = [siteFixture('site-1', 'Alpha'), siteFixture('site-2', 'Bravo')]

describe('layouts/default — header site switcher', () => {
  beforeEach(() => {
    clearNuxtData()
    h.routeRef.value = { path: '/', params: {} }
    h.activeRef.value = null
    h.navigateToMock.mockReset()
  })

  it('renders a switcher listing every site from GET /api/sites', async () => {
    registerSites(TWO)
    const wrapper = await mountSuspended(DefaultLayout)
    const sw = wrapper.get('[data-testid="site-switcher"]')
    const opts = sw.findAll('option').map((o) => o.text())
    expect(opts).toContain('Alpha')
    expect(opts).toContain('Bravo')
  })

  it('navigates to /sites/<id> when a site is chosen', async () => {
    registerSites(TWO)
    const wrapper = await mountSuspended(DefaultLayout)
    const sw = wrapper.get('[data-testid="site-switcher"]')
    await sw.setValue('site-2')
    expect(h.navigateToMock).toHaveBeenCalledWith('/sites/site-2')
  })

  it('marks the current site as selected on a /sites/:id route', async () => {
    registerSites(TWO)
    h.routeRef.value = { path: '/sites/site-2', params: { id: 'site-2' } }
    const wrapper = await mountSuspended(DefaultLayout)
    const sw = wrapper.get('[data-testid="site-switcher"]').element as HTMLSelectElement
    expect(sw.value).toBe('site-2')
  })

  it('marks the current site as selected on a /scans/:id route via active-site state', async () => {
    registerSites(TWO)
    h.routeRef.value = { path: '/scans/scan-1', params: { id: 'scan-1' } }
    h.activeRef.value = 'site-1'
    const wrapper = await mountSuspended(DefaultLayout)
    const sw = wrapper.get('[data-testid="site-switcher"]').element as HTMLSelectElement
    expect(sw.value).toBe('site-1')
  })

  it('hides the switcher but keeps New site when there are no sites', async () => {
    registerSites([])
    const wrapper = await mountSuspended(DefaultLayout)
    expect(wrapper.find('[data-testid="site-switcher"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/sites/new"]').exists()).toBe(true)
  })

  it('sizes to the site name (w-auto, no truncation) with a mobile width cap', async () => {
    registerSites(TWO)
    const wrapper = await mountSuspended(DefaultLayout)
    const cls = wrapper.get('[data-testid="site-switcher"]').classes()
    // Content-sized so the full site name shows, not clipped...
    expect(cls).toContain('w-auto')
    expect(cls).not.toContain('truncate')
    // ...but still capped on narrow screens so the header cannot scroll sideways.
    expect(cls.join(' ')).toMatch(/max-w-/)
  })
})
