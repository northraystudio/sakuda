import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SiteForm from '~/components/site/SiteForm.vue'
import { buttonElement, inputElement } from '../helpers/dom'
import {
  SiteInputSchema,
  SiteUpdateSchema,
  type SiteInput,
  type SiteUpdateInput,
} from '#shared/schemas/site'
import type { SitePublic } from '#shared/types/api'

const editSite: SitePublic = {
  id: 'site-1',
  name: 'Example',
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
  headerNames: ['Authorization', 'X-Api-Key'],
  browserStorageNames: [],
  requestShapes: {},
  requiresConfirmation: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

interface EmitsSubmit {
  emitted: (name: string) => unknown[][] | undefined
}

/** Validates (rather than casts) the emitted payload against the real
 * schema, so a shape drift in SiteForm fails the test instead of silently
 * passing through an unchecked `as SiteInput`. */
function emittedSubmit(wrapper: EmitsSubmit): SiteInput {
  const events = wrapper.emitted('submit')
  const first = events?.[0]?.[0]
  if (first === undefined) throw new Error('submit was not emitted')
  return SiteInputSchema.parse(first)
}

/** Edit-mode payloads go to `PUT`, whose schema lets header rows omit `value`. */
function emittedUpdate(wrapper: EmitsSubmit): SiteUpdateInput {
  const events = wrapper.emitted('submit')
  const first = events?.[0]?.[0]
  if (first === undefined) throw new Error('submit was not emitted')
  return SiteUpdateSchema.parse(first)
}

/** The raw emitted payload, unparsed — for asserting what the form sends
 * when the server (not the form) is the one expected to reject it. */
function emittedRaw(wrapper: EmitsSubmit): SiteUpdateInput {
  const events = wrapper.emitted('submit')
  const first = events?.[0]?.[0]
  if (first === undefined) throw new Error('submit was not emitted')
  // Not validated on purpose: the assertion is about the outgoing shape.
  return first as SiteUpdateInput
}

describe('SiteForm', () => {
  it('renders default values', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    expect(inputElement(wrapper, '[data-testid="nuclei-rate-limit"]').value).toBe('50')
    expect(inputElement(wrapper, '[data-testid="zap-fe-seed-path"]').value).toBe('/')
  })

  it('shows no confirmation checkbox on a fresh, blank form', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    expect(wrapper.find('[data-testid="non-local-confirm"]').exists()).toBe(false)
  })

  it('reveals the non-local confirmation for a non-local frontBaseUrl and blocks submit until checked', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="front-base-url"]').setValue('https://shop.example.com')

    const confirm = wrapper.find('[data-testid="non-local-confirm"]')
    expect(confirm.exists()).toBe(true)
    const submit = buttonElement(wrapper, '[data-testid="submit"]')
    expect(submit.disabled).toBe(true)

    await confirm.setValue(true)
    expect(submit.disabled).toBe(false)
  })

  it('submits active injection checks off by default and on once the checkbox is ticked', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="name"]').setValue('Example')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3000')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')
    expect(emittedSubmit(wrapper).allowMutatingRequests).toBe(false)

    await wrapper.find('[data-testid="allow-mutating-requests"]').setValue(true)
    await wrapper.find('[data-testid="site-form"]').trigger('submit')
    const events = wrapper.emitted('submit')
    const last = events?.[events.length - 1]?.[0]
    expect(SiteInputSchema.parse(last).allowMutatingRequests).toBe(true)
  })

  it('submits selected risk tags and disables them until active injection checks is on', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="name"]').setValue('Example')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3000')

    const fuzz = wrapper.find('[data-testid="risk-tag-fuzz"]')
    expect((fuzz.element as HTMLInputElement).disabled).toBe(true)

    await wrapper.find('[data-testid="allow-mutating-requests"]').setValue(true)
    expect((fuzz.element as HTMLInputElement).disabled).toBe(false)
    await fuzz.setValue(true)
    await wrapper.find('[data-testid="site-form"]').trigger('submit')

    const events = wrapper.emitted('submit')
    const last = events?.[events.length - 1]?.[0]
    expect(SiteInputSchema.parse(last).nucleiEnabledRiskTags).toEqual(['fuzz'])
  })

  it('hides the non-local confirmation for a local frontBaseUrl', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3001')
    expect(wrapper.find('[data-testid="non-local-confirm"]').exists()).toBe(false)
  })

  it('emits SiteInput with empty optional fields as null and numeric fields as numbers', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="name"]').setValue('Example')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3000')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')

    const payload = emittedSubmit(wrapper)
    expect(payload.name).toBe('Example')
    expect(payload.apiBaseUrl).toBeNull()
    expect(payload.openapiUrl).toBeNull()
    expect(payload.openapiJson).toBeNull()
    expect(payload.nucleiRateLimit).toBe(50)
    expect(typeof payload.nucleiRateLimit).toBe('number')
    expect(payload.headers).toEqual([])
  })

  it('falls back to the schema defaults when a numeric field is cleared', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="name"]').setValue('Example')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3000')
    await wrapper.find('[data-testid="nuclei-rate-limit"]').setValue('')
    await wrapper.find('[data-testid="zap-api-max-minutes"]').setValue('')
    await wrapper.find('[data-testid="zap-fe-spider-max-minutes"]').setValue('')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')

    const payload = emittedSubmit(wrapper)
    expect(payload.nucleiRateLimit).toBe(50)
    expect(payload.zapApiMaxMinutes).toBe(45)
    expect(payload.zapFeSpiderMaxMinutes).toBe(5)
  })

  // #10: optional overrides — empty means "use the server's env value".
  it('submits the nuclei limit overrides as null when left empty', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="name"]').setValue('Example')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3000')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')

    const raw = wrapper.emitted('submit')?.[0]?.[0] as Record<string, unknown> // raw payload, pre-schema
    expect(raw.nucleiMaxMinutes).toBeNull()
    expect(raw.nucleiConcurrency).toBeNull()
  })

  it('edit mode shows the saved nuclei limits, submits edits, and clears to null', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: {
        initial: { ...editSite, nucleiMaxMinutes: 240, nucleiConcurrency: 10 },
        submitting: false,
        errorMessage: null,
      },
    })
    const minutes = () => wrapper.find('[data-testid="nuclei-max-minutes"]')
    const concurrency = () => wrapper.find('[data-testid="nuclei-concurrency"]')
    expect((minutes().element as HTMLInputElement).value).toBe('240')
    expect((concurrency().element as HTMLInputElement).value).toBe('10')

    await minutes().setValue('90')
    await concurrency().setValue('')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')

    const payload = emittedUpdate(wrapper)
    expect(payload.nucleiMaxMinutes).toBe(90)
    expect(payload.nucleiConcurrency).toBeNull()
  })

  // One site field, two boxes: zap-fe's active scan spends the same budget as
  // zap-api's, so the value must stay identical whichever box is edited.
  it('keeps the two Active scan max minutes boxes in sync and submits one value', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    const fe = () => wrapper.find('[data-testid="zap-fe-active-scan-max-minutes"]')
    const api = () => wrapper.find('[data-testid="zap-api-max-minutes"]')
    expect((fe().element as HTMLInputElement).value).toBe('45')

    await fe().setValue('12')
    expect((api().element as HTMLInputElement).value).toBe('12')
    await api().setValue('30')
    expect((fe().element as HTMLInputElement).value).toBe('30')

    await wrapper.find('[data-testid="name"]').setValue('Example')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3000')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')
    expect(emittedSubmit(wrapper).zapApiMaxMinutes).toBe(30)
  })

  it('falls back to the schema default when the frontend Active scan box is cleared', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="name"]').setValue('Example')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3000')
    await wrapper.find('[data-testid="zap-fe-active-scan-max-minutes"]').setValue('')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')

    expect(emittedSubmit(wrapper).zapApiMaxMinutes).toBe(45)
  })

  it('renders header value inputs as password fields that are never prefilled', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="add-header"]').trigger('click')
    const value = wrapper.find('[data-testid="header-value-0"]')
    expect(value.attributes('type')).toBe('password')
    expect(inputElement(wrapper, '[data-testid="header-value-0"]').value).toBe('')
  })

  it('drops a new header row that has a value but no name', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="name"]').setValue('Example')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3000')
    await wrapper.find('[data-testid="add-header"]').trigger('click')
    await wrapper.find('[data-testid="header-value-0"]').setValue('secret')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')
    expect(emittedSubmit(wrapper).headers).toEqual([])
  })

  it('drops a header row that has a name but no value', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="name"]').setValue('Example')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:3000')
    await wrapper.find('[data-testid="add-header"]').trigger('click')
    await wrapper.find('[data-testid="header-name-0"]').setValue('Authorization')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')

    const payload = emittedSubmit(wrapper)
    expect(payload.headers).toEqual([])
  })

  describe('edit mode header rows', () => {
    async function mountEdit() {
      return mountSuspended(SiteForm, {
        props: { initial: editSite, submitting: false, errorMessage: null },
      })
    }

    it('shows every stored name as a row with an empty "unchanged" value and no Replace button', async () => {
      const wrapper = await mountEdit()
      expect(wrapper.find('[data-testid="headers-editor"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="replace-headers"]').exists()).toBe(false)
      expect(inputElement(wrapper, '[data-testid="header-name-0"]').value).toBe('Authorization')
      expect(inputElement(wrapper, '[data-testid="header-name-1"]').value).toBe('X-Api-Key')
      for (const i of [0, 1]) {
        const value = wrapper.find(`[data-testid="header-value-${i}"]`)
        expect(value.attributes('type')).toBe('password')
        expect(value.attributes('placeholder')).toBe('unchanged')
        expect(inputElement(wrapper, `[data-testid="header-value-${i}"]`).value).toBe('')
      }
    })

    it('sends untouched rows as name-only and a row with a typed value as name + value', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="header-value-1"]').setValue('new-key')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).headers).toEqual([
        { name: 'Authorization' },
        { name: 'X-Api-Key', value: 'new-key' },
      ])
    })

    it('removing a row drops it and adding a row appends name + value', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="remove-header-0"]').trigger('click')
      await wrapper.find('[data-testid="add-header"]').trigger('click')
      await wrapper.find('[data-testid="header-name-1"]').setValue('Cookie')
      await wrapper.find('[data-testid="header-value-1"]').setValue('token=1')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).headers).toEqual([
        { name: 'X-Api-Key' },
        { name: 'Cookie', value: 'token=1' },
      ])
    })

    it('drops a new row that has a name but no value (only stored names may omit it)', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="add-header"]').trigger('click')
      await wrapper.find('[data-testid="header-name-2"]').setValue('X-New')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).headers).toEqual([
        { name: 'Authorization' },
        { name: 'X-Api-Key' },
      ])
    })

    it('sends a renamed stored row under its new name with no value instead of dropping it', async () => {
      // Dropping it would make the PUT list omit "Authorization", which the
      // server reads as "delete" — the stored header would vanish silently.
      // Sent as name-only, the server answers 422 (no stored value for the
      // new name) and nothing is deleted.
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="header-name-0"]').setValue('Authorisation')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).headers).toEqual([
        { name: 'Authorisation' },
        { name: 'X-Api-Key' },
      ])
    })

    it('sends a stored row whose name was cleared rather than dropping it', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="header-name-0"]').setValue('')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedRaw(wrapper).headers).toEqual([{ name: '' }, { name: 'X-Api-Key' }])
    })

    it('drops the "unchanged" placeholder once a stored row is renamed', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="header-name-0"]').setValue('Authorisation')
      expect(wrapper.find('[data-testid="header-value-0"]').attributes('placeholder')).toBe(
        'Header value',
      )
      await wrapper.find('[data-testid="header-name-0"]').setValue('Authorization')
      expect(wrapper.find('[data-testid="header-value-0"]').attributes('placeholder')).toBe(
        'unchanged',
      )
    })

    it('with no stored headers the editor starts empty and submits []', async () => {
      const wrapper = await mountSuspended(SiteForm, {
        props: {
          initial: { ...editSite, headerNames: [] },
          submitting: false,
          errorMessage: null,
        },
      })
      expect(wrapper.find('[data-testid="header-name-0"]').exists()).toBe(false)
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).headers).toEqual([])
    })
  })

  it('renders the errorMessage prop in a text-sale block', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: 'boom' },
    })
    const el = wrapper.find('[data-testid="form-error"]')
    expect(el.exists()).toBe(true)
    expect(el.classes()).toContain('text-sale')
    expect(el.text()).toBe('boom')
  })

  it('disables submit while submitting', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: true, errorMessage: null },
    })
    expect(buttonElement(wrapper, '[data-testid="submit"]').disabled).toBe(true)
  })

  it('submits discovery seed paths and complete browser-storage rows; values are password inputs', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    await wrapper.find('[data-testid="name"]').setValue('Shop')
    await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:4001')
    // the list is only editable once "From listed routes" is chosen
    await wrapper.find('[data-testid="discovery-start-listed"]').trigger('change')
    await wrapper.find('[data-testid="discovery-seed-paths"]').setValue('/#/\n/#/basket')
    await wrapper.find('[data-testid="crawl-scope-paths"]').setValue('/rest\n/api')

    await wrapper.find('[data-testid="add-storage"]').trigger('click')
    await wrapper.find('[data-testid="add-storage"]').trigger('click')
    expect(inputElement(wrapper, '[data-testid="storage-value-0"]').type).toBe('password')
    expect(inputElement(wrapper, '[data-testid="storage-value-0"]').value).toBe('')
    await wrapper.find('[data-testid="storage-kind-0"]').setValue('sessionStorage')
    await wrapper.find('[data-testid="storage-name-0"]').setValue('bid')
    await wrapper.find('[data-testid="storage-value-0"]').setValue('6')
    // second row left without a value → dropped, not submitted half-filled
    await wrapper.find('[data-testid="storage-name-1"]').setValue('token')
    await wrapper.find('[data-testid="site-form"]').trigger('submit')

    const payload = emittedSubmit(wrapper)
    expect(payload.discoverySeedPaths).toBe('/#/\n/#/basket')
    expect(payload.crawlScopePaths).toBe('/rest\n/api')
    expect(payload.browserStorage).toEqual([{ kind: 'sessionStorage', name: 'bid', value: '6' }])
  })

  describe('edit mode browser-storage rows', () => {
    const editStorageSite = {
      ...editSite,
      browserStorageNames: [
        { kind: 'localStorage' as const, name: 'token' },
        { kind: 'cookie' as const, name: 'sid' },
      ],
    }
    async function mountEdit() {
      return mountSuspended(SiteForm, {
        props: { initial: editStorageSite, submitting: false, errorMessage: null },
      })
    }

    it('shows every stored item as a row with an empty "unchanged" value and no Replace button', async () => {
      const wrapper = await mountEdit()
      expect(wrapper.find('[data-testid="storage-editor"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="replace-storage"]').exists()).toBe(false)
      expect(inputElement(wrapper, '[data-testid="storage-name-0"]').value).toBe('token')
      expect(inputElement(wrapper, '[data-testid="storage-name-1"]').value).toBe('sid')
      for (const i of [0, 1]) {
        const value = wrapper.find(`[data-testid="storage-value-${i}"]`)
        expect(value.attributes('type')).toBe('password')
        expect(value.attributes('placeholder')).toBe('unchanged')
        expect(inputElement(wrapper, `[data-testid="storage-value-${i}"]`).value).toBe('')
      }
    })

    it('sends untouched rows as kind+name only and a typed row as kind+name+value', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="storage-value-1"]').setValue('newsid')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).browserStorage).toEqual([
        { kind: 'localStorage', name: 'token' },
        { kind: 'cookie', name: 'sid', value: 'newsid' },
      ])
    })

    it('removing a row drops it and adding a row appends a full item', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="remove-storage-0"]').trigger('click')
      await wrapper.find('[data-testid="add-storage"]').trigger('click')
      await wrapper.find('[data-testid="storage-name-1"]').setValue('bid')
      await wrapper.find('[data-testid="storage-value-1"]').setValue('6')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).browserStorage).toEqual([
        { kind: 'cookie', name: 'sid' },
        { kind: 'localStorage', name: 'bid', value: '6' },
      ])
    })

    it('sends a stored row whose kind or name changed under the new pair with no value', async () => {
      // Same silent-deletion trap as headers: a changed (kind, name) no longer
      // matches the stored set, and dropping the row would delete the original.
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="storage-kind-0"]').setValue('cookie')
      await wrapper.find('[data-testid="storage-name-1"]').setValue('sid2')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).browserStorage).toEqual([
        { kind: 'cookie', name: 'token' },
        { kind: 'cookie', name: 'sid2' },
      ])
    })

    it('sends a stored row whose name was cleared rather than dropping it', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="storage-name-0"]').setValue('')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedRaw(wrapper).browserStorage).toEqual([
        { kind: 'localStorage', name: '' },
        { kind: 'cookie', name: 'sid' },
      ])
    })

    it('drops the "unchanged" placeholder once a stored row\'s kind or name changes', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="storage-kind-0"]').setValue('cookie')
      expect(wrapper.find('[data-testid="storage-value-0"]').attributes('placeholder')).toBe(
        'Value',
      )
      await wrapper.find('[data-testid="storage-kind-0"]').setValue('localStorage')
      expect(wrapper.find('[data-testid="storage-value-0"]').attributes('placeholder')).toBe(
        'unchanged',
      )
    })

    it('drops a new storage row that has a value but no name', async () => {
      const wrapper = await mountEdit()
      await wrapper.find('[data-testid="add-storage"]').trigger('click')
      await wrapper.find('[data-testid="storage-value-2"]').setValue('secret')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).browserStorage).toEqual([
        { kind: 'localStorage', name: 'token' },
        { kind: 'cookie', name: 'sid' },
      ])
    })

    it('with no stored items the editor starts empty and submits []', async () => {
      const wrapper = await mountSuspended(SiteForm, {
        props: {
          initial: { ...editSite, browserStorageNames: [] },
          submitting: false,
          errorMessage: null,
        },
      })
      expect(wrapper.find('[data-testid="storage-name-0"]').exists()).toBe(false)
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      expect(emittedUpdate(wrapper).browserStorage).toEqual([])
    })
  })

  it('groups the fields into engine sections, each with a legend and engine badges', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    const sections = wrapper.findAll('fieldset[data-testid^="section-"]')
    // the order in which the scan targets are determined, numbered in the legends
    expect(sections.map((s) => s.attributes('data-testid'))).toEqual([
      'section-site',
      'section-auth',
      'section-active',
      'section-crawl',
      'section-targets',
      'section-nuclei',
      'section-zap-fe',
      'section-zap-api',
    ])
    expect(sections.map((s) => s.find('legend [data-testid="section-step"]').text())).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '6',
      '6',
    ])
    for (const s of sections) expect(s.find('[data-testid="section-note"]').exists()).toBe(true)
    const badgesOf = (testid: string) =>
      wrapper
        .find(`[data-testid="${testid}"]`)
        .findAll('legend [data-testid="engine-badge"]')
        .map((b) => b.text())
    // every section is a bordered box with a heading-lg legend
    for (const s of sections) {
      expect(s.classes()).toEqual(expect.arrayContaining(['card', 'border-hairline']))
      expect(s.find('legend .text-heading-lg').exists()).toBe(true)
    }
    expect(badgesOf('section-site')).toEqual(['All engines'])
    expect(badgesOf('section-auth')).toEqual(['All engines'])
    expect(badgesOf('section-active')).toEqual(['Nuclei', 'ZAP frontend', 'ZAP API', 'Dalfox'])
    expect(badgesOf('section-crawl')).toEqual(['Discovery'])
    expect(badgesOf('section-targets')).toEqual(['All engines'])
    expect(badgesOf('section-nuclei')).toEqual(['Nuclei'])
    expect(badgesOf('section-zap-fe')).toEqual(['ZAP frontend'])
    expect(badgesOf('section-zap-api')).toEqual(['ZAP API'])

    // each field sits in the section of the engine that reads it
    const within = (testid: string, field: string) =>
      wrapper.find(`[data-testid="${testid}"] [data-testid="${field}"]`).exists()
    // each field sits in the step that determines it
    expect(within('section-site', 'exclude-paths')).toBe(true)
    expect(within('section-auth', 'add-header')).toBe(true)
    expect(within('section-auth', 'add-storage')).toBe(true)
    expect(within('section-active', 'allow-mutating-requests')).toBe(true)
    expect(within('section-crawl', 'zap-fe-seed-path')).toBe(true)
    expect(within('section-crawl', 'discovery-seed-paths')).toBe(true)
    expect(within('section-crawl', 'crawl-scope-paths')).toBe(true)
    expect(within('section-targets', 'nuclei-paths')).toBe(true)
    expect(within('section-nuclei', 'nuclei-rate-limit')).toBe(true)
    expect(within('section-nuclei', 'risk-tag-fuzz')).toBe(true)
    expect(within('section-zap-fe', 'zap-fe-spider-max-minutes')).toBe(true)
    expect(within('section-zap-api', 'openapi-json')).toBe(true)
    expect(within('section-zap-api', 'zap-api-max-minutes')).toBe(true)
    // the shared active-scan budget is reachable from the frontend section too
    expect(within('section-zap-fe', 'zap-fe-active-scan-max-minutes')).toBe(true)
    expect(within('section-active', 'allow-mutating-requests')).toBe(true)
    expect(within('section-auth', 'add-header')).toBe(true)
  })

  it('renders a Cancel link next to submit only when cancelTo is given', async () => {
    const withCancel = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null, cancelTo: '/sites/site-1' },
    })
    const cancel = withCancel.find('[data-testid="cancel"]')
    expect(cancel.exists()).toBe(true)
    expect(cancel.attributes('href')).toBe('/sites/site-1')
    expect(cancel.text()).toBe('Cancel')

    const without = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    expect(without.find('[data-testid="cancel"]').exists()).toBe(false)
  })

  it('mirrors a new initial.nucleiPaths into Target paths (the discovery panel saves server-side)', async () => {
    const wrapper = await mountSuspended(SiteForm, {
      props: {
        initial: { ...editSite, nucleiPaths: '/\n' },
        submitting: false,
        errorMessage: null,
      },
    })
    const textarea = wrapper.find('[data-testid="nuclei-paths"]').element
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('expected a <textarea>')
    expect(textarea.value).toBe('/\n')

    await wrapper.setProps({ initial: { ...editSite, nucleiPaths: '/\n/login\n' } })
    expect(textarea.value).toBe('/\n/login\n')
    // and the synced value is what Save submits
    await wrapper.find('[data-testid="site-form"]').trigger('submit')
    expect(emittedUpdate(wrapper).nucleiPaths).toBe('/\n/login\n')
  })

  it('renders the Target paths textarea by default and replaces it with the `targets` slot when given', async () => {
    const plain = await mountSuspended(SiteForm, {
      props: { submitting: false, errorMessage: null },
    })
    expect(
      plain.find('[data-testid="section-targets"] [data-testid="nuclei-paths"]').exists(),
    ).toBe(true)

    const slotted = await mountSuspended(SiteForm, {
      props: {
        initial: { ...editSite, nucleiPaths: '/\n' },
        submitting: false,
        errorMessage: null,
      },
      slots: { targets: '<div data-testid="slot-content">panel</div>' },
    })
    const section = slotted.find('[data-testid="section-targets"]')
    expect(section.find('[data-testid="slot-content"]').exists()).toBe(true)
    expect(section.find('[data-testid="nuclei-paths"]').exists()).toBe(false)
    // the mirrored server value is what Save submits — untouched by the user here
    await slotted.find('[data-testid="site-form"]').trigger('submit')
    expect(emittedUpdate(slotted).nucleiPaths).toBe('/\n')
  })

  describe('crawl starts (seed path vs listed routes)', () => {
    const radio = (wrapper: Awaited<ReturnType<typeof mountSuspended>>, id: string) =>
      inputElement(wrapper, `[data-testid="discovery-start-${id}"]`)
    const seedInput = (wrapper: Awaited<ReturnType<typeof mountSuspended>>) =>
      inputElement(wrapper, '[data-testid="zap-fe-seed-path"]')
    const listArea = (wrapper: Awaited<ReturnType<typeof mountSuspended>>) => {
      const el = wrapper.find('[data-testid="discovery-seed-paths"]').element
      if (!(el instanceof HTMLTextAreaElement)) throw new Error('expected a <textarea>')
      return el
    }
    const mountWith = (initial: Partial<SitePublic>) =>
      mountSuspended(SiteForm, {
        props: { initial: { ...editSite, ...initial }, submitting: false, errorMessage: null },
      })

    it('picks the mode from the stored list: none or one line → seed path, two or more → listed', async () => {
      const fresh = await mountSuspended(SiteForm, {
        props: { submitting: false, errorMessage: null },
      })
      expect(radio(fresh, 'seed').checked).toBe(true)
      expect(seedInput(fresh).disabled).toBe(false)
      expect(listArea(fresh).disabled).toBe(true)

      const one = await mountWith({ zapFeSeedPath: '/', discoverySeedPaths: '/#/' })
      expect(radio(one, 'seed').checked).toBe(true)
      expect(seedInput(one).value).toBe('/#/') // the single listed line is the start

      const many = await mountWith({ discoverySeedPaths: '/#/\n/#/basket' })
      expect(radio(many, 'listed').checked).toBe(true)
      expect(seedInput(many).disabled).toBe(true)
      expect(listArea(many).disabled).toBe(false)
    })

    it('listed routes: the list is saved and its first line becomes the seed path', async () => {
      const wrapper = await mountSuspended(SiteForm, {
        props: { submitting: false, errorMessage: null },
      })
      await wrapper.find('[data-testid="name"]').setValue('Shop')
      await wrapper.find('[data-testid="front-base-url"]').setValue('http://localhost:4001')
      await wrapper.find('[data-testid="discovery-start-listed"]').trigger('change')
      // switching prefills an empty list with the seed path — nothing is lost
      expect(listArea(wrapper).value).toBe('/')
      await wrapper.find('[data-testid="discovery-seed-paths"]').setValue('/#/\n/#/basket')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      const payload = emittedSubmit(wrapper)
      expect(payload.discoverySeedPaths).toBe('/#/\n/#/basket')
      expect(payload.zapFeSeedPath).toBe('/#/')
    })

    it('seed path: the list is not saved, and switching back shows the first listed line', async () => {
      const wrapper = await mountWith({ discoverySeedPaths: '/#/\n/#/basket' })
      await wrapper.find('[data-testid="discovery-start-seed"]').trigger('change')
      expect(seedInput(wrapper).value).toBe('/#/')
      // the typed list stays in the (disabled) textarea — no reset on switch
      expect(listArea(wrapper).value).toBe('/#/\n/#/basket')
      await wrapper.find('[data-testid="site-form"]').trigger('submit')
      const payload = emittedUpdate(wrapper)
      expect(payload.zapFeSeedPath).toBe('/#/')
      expect(payload.discoverySeedPaths).toBe('')
    })

    it('blocks submit with a message when the chosen start has nothing in it', async () => {
      const wrapper = await mountSuspended(SiteForm, {
        props: { submitting: false, errorMessage: null },
      })
      await wrapper.find('[data-testid="zap-fe-seed-path"]').setValue('')
      expect(wrapper.find('[data-testid="discovery-start-error"]').exists()).toBe(true)
      expect(buttonElement(wrapper, '[data-testid="submit"]').disabled).toBe(true)

      await wrapper.find('[data-testid="discovery-start-listed"]').trigger('change')
      // nothing to prefill from, so the list is empty and still blocked
      expect(wrapper.find('[data-testid="discovery-start-error"]').exists()).toBe(true)
      expect(buttonElement(wrapper, '[data-testid="submit"]').disabled).toBe(true)
      await wrapper.find('[data-testid="discovery-seed-paths"]').setValue('/#/basket')
      expect(wrapper.find('[data-testid="discovery-start-error"]').exists()).toBe(false)
      expect(buttonElement(wrapper, '[data-testid="submit"]').disabled).toBe(false)
    })
  })
})
