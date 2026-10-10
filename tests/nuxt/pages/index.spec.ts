import { beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'
import type { SiteListItem } from '#shared/types/api'

function siteFixture(overrides: Partial<SiteListItem> = {}): SiteListItem {
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
    requiresConfirmation: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastScan: {
      id: 'scan-1',
      siteId: 'site-1',
      status: 'done',
      engines: ['nuclei'],
      createdAt: '2026-01-02T00:00:00.000Z',
      startedAt: '2026-01-02T00:00:00.000Z',
      finishedAt: '2026-01-02T00:05:00.000Z',
      error: null,
      counts: { critical: 1, high: 2, medium: 0, low: 3, info: 4 },
    },
    ...overrides,
  }
}

describe('pages/index', () => {
  beforeEach(() => {
    // useFetch caches by URL in the shared Nuxt app instance across tests
    // in this file — clear it so each test observes only its own endpoint.
    clearNuxtData()
  })

  it('renders each site name and its reported finding total', async () => {
    registerEndpoint('/api/sites', () => [siteFixture()])
    const wrapper = await mountSuspended(IndexPage)

    expect(wrapper.text()).toContain('Example Shop')
    expect(wrapper.text()).toContain('shop.example.com')
    expect(wrapper.text()).toContain('done')
    expect(wrapper.text()).toContain('3')
  })

  it('shows the empty state with a link to create a site when there are none', async () => {
    registerEndpoint('/api/sites', () => [])
    const wrapper = await mountSuspended(IndexPage)

    const empty = wrapper.find('[data-testid="empty-state"]')
    expect(empty.exists()).toBe(true)
    expect(wrapper.find('a[href="/sites/new"]').exists()).toBe(true)
  })
})
