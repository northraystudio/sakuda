import { beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import SiteEditPage from '~/pages/sites/[id]/edit.vue'
import type { SitePublic } from '#shared/types/api'

const site: SitePublic = {
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
}

describe('pages/sites/[id]/edit', () => {
  beforeEach(() => {
    clearNuxtData()
    registerEndpoint(`/api/sites/${site.id}`, () => site)
    registerEndpoint(`/api/sites/${site.id}/discoveries`, () => [])
  })

  it('starts with the Site section and hosts the discovery panel inside Targets — no separate card, no Target paths textarea', async () => {
    const wrapper = await mountSuspended(SiteEditPage, { route: `/sites/${site.id}/edit` })
    // nothing above the form: Site is the first thing after the heading
    expect(wrapper.find('[data-testid="targets-section"]').exists()).toBe(false)
    const order = wrapper
      .findAll('fieldset[data-testid^="section-"]')
      .map((s) => s.attributes('data-testid'))
    expect(order[0]).toBe('section-site')
    // Targets comes after everything discovery depends on (auth, active checks, crawl)
    expect(order.indexOf('section-targets')).toBeGreaterThan(order.indexOf('section-crawl'))
    expect(order.indexOf('section-crawl')).toBeGreaterThan(order.indexOf('section-active'))
    expect(order.indexOf('section-active')).toBeGreaterThan(order.indexOf('section-auth'))
    const targets = wrapper.find('[data-testid="section-targets"]')
    expect(targets.find('[data-testid="discovery-panel"]').exists()).toBe(true)
    expect(targets.find('[data-testid="targets-detected"]').exists()).toBe(true)
    expect(targets.find('[data-testid="targets-add"]').exists()).toBe(true)
    expect(targets.find('[data-testid="start-discovery"]').exists()).toBe(true)
    // the panel is the only editor of the saved list on this page
    expect(wrapper.find('[data-testid="nuclei-paths"]').exists()).toBe(false)
  })

  it('offers a Cancel link back to the site page, beside Save', async () => {
    const wrapper = await mountSuspended(SiteEditPage, { route: `/sites/${site.id}/edit` })
    const cancel = wrapper.find('[data-testid="cancel"]')
    expect(cancel.exists()).toBe(true)
    expect(cancel.attributes('href')).toBe(`/sites/${site.id}`)
    expect(wrapper.find('[data-testid="submit"]').text()).toBe('Save changes')
  })
})
