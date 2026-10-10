import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises, type DOMWrapper } from '@vue/test-utils'
import { createError, readBody } from 'h3'
import DiscoveryPanel from '~/components/site/DiscoveryPanel.vue'
import { buttonElement } from '../helpers/dom'
import type {
  AddTargetsResult,
  DiscoveryDetail,
  DiscoverySummary,
  RemoveTargetResult,
  SitePublic,
} from '#shared/types/api'

function siteFixture(overrides: Partial<SitePublic> = {}): SitePublic {
  return {
    id: 'site-1',
    name: 'Example',
    frontBaseUrl: 'http://localhost:4001',
    apiBaseUrl: null,
    nucleiPaths: '/\n/already-saved',
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

function summaryFixture(overrides: Partial<DiscoverySummary> = {}): DiscoverySummary {
  return {
    id: 'disc-1',
    siteId: 'site-1',
    status: 'done',
    createdAt: '2026-01-02T10:00:00.000Z',
    startedAt: '2026-01-02T10:00:01.000Z',
    finishedAt: '2026-01-02T10:03:00.000Z',
    error: null,
    urlCount: 3,
    ...overrides,
  }
}

function detailFixture(overrides: Partial<DiscoveryDetail> = {}): DiscoveryDetail {
  return {
    ...summaryFixture(),
    urls: [
      { url: 'http://localhost:4001/', method: 'GET', statusCode: 200, source: 'spider' },
      {
        url: 'http://localhost:4001/rest/products/search?q=',
        method: 'GET',
        statusCode: 200,
        source: 'ajax',
      },
      {
        url: 'http://localhost:4001/already-saved',
        method: 'GET',
        statusCode: 200,
        source: 'spider',
      },
    ],
    meta: { nodeCount: 12, dropped: { asset: 4, noise: 2, invalid: 0 } },
    warnings: ['1 request(s) got 401/403 — headers may be missing or expired'],
    ...overrides,
  }
}

const unregisters: Array<() => void> = []
function endpoint(...args: Parameters<typeof registerEndpoint>) {
  unregisters.push(registerEndpoint(...args))
}

let activeWrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined

async function mountPanel(site = siteFixture()) {
  activeWrapper = await mountSuspended(DiscoveryPanel, { props: { site } })
  await flushPromises()
  await flushPromises()
  return activeWrapper
}

describe('DiscoveryPanel', () => {
  beforeEach(() => {
    clearNuxtData()
  })

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = undefined
    for (const u of unregisters.splice(0)) u()
  })

  it('before any discovery: enabled Discover button, and the saved lines already listed as "manual"', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [])
    const wrapper = await mountPanel() // nucleiPaths: '/\n/already-saved'

    expect(wrapper.text()).toContain('No discovery yet')
    expect(buttonElement(wrapper, '[data-testid="start-discovery"]').disabled).toBe(false)
    // the saved list is always visible here, whatever the last crawl returned
    const rows = wrapper.findAll('[data-testid="discovered-url"]')
    expect(
      rows.map((r: DOMWrapper<Element>) => r.find('[data-testid="discovered-url-source"]').text()),
    ).toEqual(['manual', 'manual'])
    expect(rows[1]?.text()).toContain('/already-saved')
    expect(rows[1]?.find('[data-testid="remove-target"]').exists()).toBe(true)
    // two areas: detected (no free text) and add (the only textarea)
    expect(wrapper.find('[data-testid="targets-detected"] textarea').exists()).toBe(false)
    expect(wrapper.find('[data-testid="targets-add"] textarea').exists()).toBe(true)
    // nothing to save yet
    expect(buttonElement(wrapper, '[data-testid="save-targets"]').disabled).toBe(true)
  })

  it('shows the empty state when nothing is saved and nothing was discovered', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [])
    const wrapper = await mountPanel(siteFixture({ nucleiPaths: '' }))
    expect(wrapper.find('[data-testid="discovered-urls"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="no-targets"]').exists()).toBe(true)
  })

  it('keeps a hand-added line in the table after a discovery that did not return it', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [summaryFixture()])
    endpoint('/api/discoveries/disc-1', () => detailFixture())
    // '/by-hand' was saved from the Add paths area earlier; the crawl never returns it
    const wrapper = await mountPanel(
      siteFixture({ nucleiPaths: '/\n/already-saved\nPOST /by-hand\n' }),
    )

    const rows = wrapper.findAll('[data-testid="discovered-url"]')
    expect(rows).toHaveLength(4)
    const manual = rows[3]
    if (!manual) throw new Error('expected a manual row')
    expect(manual.find('[data-testid="discovered-url-method"]').text()).toBe('POST')
    expect(manual.text()).toContain('/by-hand')
    expect(manual.find('[data-testid="discovered-url-source"]').text()).toBe('manual')
    expect(manual.text()).toContain('saved')
    expect(manual.find('[data-testid="remove-target"]').exists()).toBe(true)
    // it is saved, so it is not part of the selection
    expect(wrapper.text()).toContain('1 selected')

    // a new discovery (still without it) replaces the crawl rows, not the saved ones
    endpoint('/api/sites/site-1/discoveries', {
      method: 'POST',
      handler: () => summaryFixture({ id: 'disc-2', status: 'queued', urlCount: 0 }),
    })
    endpoint('/api/discoveries/disc-2', () =>
      detailFixture({
        id: 'disc-2',
        urls: [{ url: 'http://localhost:4001/', method: 'GET', statusCode: 200, source: 'spider' }],
      }),
    )
    await wrapper.find('[data-testid="start-discovery"]').trigger('click')
    await flushPromises()
    await flushPromises()
    const after = wrapper.findAll('[data-testid="discovered-url"]')
    expect(
      after.map((r: DOMWrapper<Element>) => r.find('[data-testid="discovered-url-source"]').text()),
    ).toEqual(['spider', 'manual', 'manual'])
    expect(after.map((r: DOMWrapper<Element>) => r.text())).toEqual([
      expect.stringContaining('/'),
      expect.stringContaining('/already-saved'),
      expect.stringContaining('/by-hand'),
    ])
  })

  it('warns that discovery submits forms only when active checks are on', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [])
    const off = await mountPanel(siteFixture({ allowMutatingRequests: false }))
    expect(off.find('[data-testid="active-discovery-warning"]').exists()).toBe(false)
    off.unmount()

    endpoint('/api/sites/site-1/discoveries', () => [])
    const on = await mountPanel(siteFixture({ allowMutatingRequests: true }))
    expect(on.find('[data-testid="active-discovery-warning"]').text()).toContain('submits forms')
    on.unmount()

    // opted in, but ownership of a non-local host is unconfirmed: the engines'
    // gate (isActiveScanEnabled) keeps discovery passive, so no warning either
    endpoint('/api/sites/site-1/discoveries', () => [])
    const unconfirmed = await mountPanel(
      siteFixture({
        allowMutatingRequests: true,
        requiresConfirmation: true,
        nonLocalConfirmed: false,
      }),
    )
    expect(unconfirmed.find('[data-testid="active-discovery-warning"]').exists()).toBe(false)
  })

  it('lists the latest discovery with unsaved URLs pre-selected and saved ones marked', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [summaryFixture()])
    endpoint('/api/discoveries/disc-1', () => detailFixture())
    const wrapper = await mountPanel()

    expect(wrapper.find('[data-testid="discovery-status"]').text()).toContain('done')
    expect(wrapper.find('[data-testid="discovery-warning"]').text()).toContain('401/403')
    expect(wrapper.text()).toContain('12 nodes crawled')
    expect(wrapper.text()).toContain('asset 4, noise 2')

    const rows = wrapper.findAll('[data-testid="discovered-url"]')
    expect(rows).toHaveLength(3)
    // "/" and "/already-saved" are in nucleiPaths → marked saved, disabled, checked
    expect(rows[0]?.text()).toContain('saved')
    const checkboxes = wrapper.findAll('[data-testid="discovered-url-checkbox"]')
    const savedBox = checkboxes[0]?.element
    const newBox = checkboxes[1]?.element
    if (!(savedBox instanceof HTMLInputElement) || !(newBox instanceof HTMLInputElement))
      throw new Error('expected checkbox inputs')
    expect(savedBox.disabled).toBe(true)
    expect(savedBox.checked).toBe(true)
    expect(newBox.disabled).toBe(false)
    expect(newBox.checked).toBe(true)
    expect(wrapper.text()).toContain('1 selected')
    expect(buttonElement(wrapper, '[data-testid="save-targets"]').textContent).toContain(
      'Save 1 to targets',
    )
  })

  it('shows the method column and saves a non-GET row as a "METHOD path" line', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [summaryFixture()])
    endpoint('/api/discoveries/disc-1', () =>
      detailFixture({
        urls: [
          { url: 'http://localhost:4001/rest/x', method: 'POST', statusCode: 200, source: 'ajax' },
        ],
        warnings: [],
      }),
    )
    let posted: unknown
    endpoint('/api/sites/site-1/targets', {
      method: 'POST',
      handler: async (event) => {
        posted = await readBody(event)
        return { site: siteFixture(), added: ['POST /rest/x'], skipped: [] } as AddTargetsResult
      },
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('[data-testid="discovered-url-method"]').text()).toBe('POST')
    const row = wrapper.find('[data-testid="discovered-url"]')
    expect(row.text()).toContain('POST /rest/x')
    await wrapper.find('[data-testid="save-targets"]').trigger('click')
    await flushPromises()
    expect(posted).toEqual({ lines: ['POST /rest/x'], shapes: [] })
  })

  it('shows a body-shape badge and posts the shape with the approved line', async () => {
    const bodyShape = {
      kind: 'json' as const,
      root: {
        type: 'object' as const,
        fields: { email: { type: 'string' as const }, password: { type: 'string' as const } },
      },
    }
    endpoint('/api/sites/site-1/discoveries', () => [summaryFixture()])
    endpoint('/api/discoveries/disc-1', () =>
      detailFixture({
        urls: [
          {
            url: 'http://localhost:4001/rest/user/login',
            method: 'POST',
            statusCode: 401,
            source: 'client',
            contentType: 'application/json',
            bodyShape,
          },
        ],
        warnings: [],
      }),
    )
    let posted: unknown
    endpoint('/api/sites/site-1/targets', {
      method: 'POST',
      handler: async (event) => {
        posted = await readBody(event)
        return {
          site: siteFixture(),
          added: ['POST /rest/user/login'],
          skipped: [],
        } as AddTargetsResult
      },
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('[data-testid="discovered-url-shape"]').text()).toBe(
      'json {email, password}',
    )
    await wrapper.find('[data-testid="save-targets"]').trigger('click')
    await flushPromises()
    expect(posted).toEqual({
      lines: ['POST /rest/user/login'],
      shapes: [{ line: 'POST /rest/user/login', contentType: 'application/json', bodyShape }],
    })
  })

  it('shows the client source for a Client Spider row', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [summaryFixture()])
    endpoint('/api/discoveries/disc-1', () =>
      detailFixture({
        urls: [
          {
            url: 'http://localhost:4001/rest/user/login',
            method: 'POST',
            statusCode: 401,
            source: 'client',
          },
        ],
        warnings: [],
      }),
    )
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="discovered-url-source"]').text()).toBe('client')
  })

  it('posts the selected lines plus manual lines, then emits the updated site', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [summaryFixture()])
    endpoint('/api/discoveries/disc-1', () => detailFixture())
    let posted: unknown
    const updated = siteFixture({
      nucleiPaths: '/\n/already-saved\n/rest/products/search?q=\napi:/health\n',
    })
    endpoint('/api/sites/site-1/targets', {
      method: 'POST',
      handler: async (event) => {
        posted = await readBody(event)
        const result: AddTargetsResult = {
          site: updated,
          added: ['/rest/products/search?q=', '/health'],
          skipped: [],
        }
        return result
      },
    })
    const wrapper = await mountPanel()

    await wrapper.find('[data-testid="manual-target-lines"]').setValue('/health\n\n')
    expect(buttonElement(wrapper, '[data-testid="save-targets"]').textContent).toContain(
      'Save 2 to targets',
    )
    await wrapper.find('[data-testid="save-targets"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(posted).toEqual({ lines: ['/rest/products/search?q=', '/health'], shapes: [] })
    expect(wrapper.emitted('saved')?.[0]?.[0]).toEqual(updated)
    expect(wrapper.find('[data-testid="save-message"]').text()).toContain(
      'Saved 2 new target paths',
    )
    const manual = wrapper.find('[data-testid="manual-target-lines"]').element
    if (!(manual instanceof HTMLTextAreaElement)) throw new Error('expected a <textarea>')
    expect(manual.value).toBe('')
  })

  it('removes a saved row via DELETE and emits the updated site so the badge clears', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [summaryFixture()])
    endpoint('/api/discoveries/disc-1', () => detailFixture())
    let deleted: unknown
    const updated = siteFixture({ nucleiPaths: '/\n' })
    endpoint('/api/sites/site-1/targets', {
      method: 'DELETE',
      handler: async (event) => {
        deleted = await readBody(event)
        const result: RemoveTargetResult = { site: updated, removed: true }
        return result
      },
    })
    const wrapper = await mountPanel()

    // "/" and "/already-saved" are saved → two Remove buttons, none on the new row
    const removes = wrapper.findAll('[data-testid="remove-target"]')
    expect(removes).toHaveLength(2)
    await removes[1]?.trigger('click')
    await flushPromises()
    await flushPromises()

    expect(deleted).toEqual({ line: '/already-saved' })
    expect(wrapper.emitted('removed')?.[0]?.[0]).toEqual(updated)

    // The host page hands the updated site back; the row is now selectable.
    await wrapper.setProps({ site: updated })
    await flushPromises()
    expect(wrapper.findAll('[data-testid="remove-target"]')).toHaveLength(1)
    const box = wrapper.findAll('[data-testid="discovered-url-checkbox"]')[2]?.element
    if (!(box instanceof HTMLInputElement)) throw new Error('expected a checkbox input')
    expect(box.disabled).toBe(false)
    // the path is "/already-saved", so check for the badge, not the row text;
    // this row carries no body shape, so no badge at all should remain
    const thirdRow = wrapper.findAll('[data-testid="discovered-url"]')[2]
    if (!thirdRow) throw new Error('expected three discovered rows')
    expect(thirdRow.find('.badge').exists()).toBe(false)
  })

  it('shows the API error when removing a saved row is rejected', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [summaryFixture()])
    endpoint('/api/discoveries/disc-1', () => detailFixture())
    endpoint('/api/sites/site-1/targets', {
      method: 'DELETE',
      handler: () => {
        throw createError({ statusCode: 422, statusMessage: 'invalid target line' })
      },
    })
    const wrapper = await mountPanel()

    await wrapper.find('[data-testid="remove-target"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(wrapper.find('[data-testid="remove-error"]').text()).toContain('invalid target line')
    expect(wrapper.emitted('removed')).toBeUndefined()
  })

  it('starts a discovery and disables the button while it is running', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [])
    let posts = 0
    endpoint('/api/sites/site-1/discoveries', {
      method: 'POST',
      handler: () => {
        posts++
        return summaryFixture({ id: 'disc-9', status: 'queued', urlCount: 0, finishedAt: null })
      },
    })
    endpoint('/api/discoveries/disc-9', () =>
      detailFixture({ id: 'disc-9', status: 'running', urls: [], warnings: [], meta: {} }),
    )
    const wrapper = await mountPanel()

    await wrapper.find('[data-testid="start-discovery"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(posts).toBe(1)
    expect(buttonElement(wrapper, '[data-testid="start-discovery"]').disabled).toBe(true)
    expect(wrapper.find('[data-testid="start-discovery"]').text()).toContain('Discovering')
    expect(wrapper.find('[data-testid="discovery-status"]').text()).toContain('running')
  })

  it('shows the API error when starting a discovery is rejected', async () => {
    endpoint('/api/sites/site-1/discoveries', () => [])
    endpoint('/api/sites/site-1/discoveries', {
      method: 'POST',
      handler: () => {
        throw createError({ statusCode: 409, statusMessage: 'site has an active scan' })
      },
    })
    const wrapper = await mountPanel()

    await wrapper.find('[data-testid="start-discovery"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(wrapper.find('[data-testid="discovery-error"]').text()).toContain('active scan')
  })
})
