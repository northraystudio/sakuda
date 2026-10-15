import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick, ref } from 'vue'
import ScanPage from '~/pages/scans/[id].vue'
import { engineRunFixture, findingFixture, scanDetailFixture } from '../helpers/fixtures'
import type { ScanDetail, ScanProgressView } from '#shared/types/api'

const polling = {
  state: ref<ScanDetail | null>(null),
  error: ref<string | null>(null),
  done: ref(false),
  start: vi.fn(),
  stop: vi.fn(),
}

mockNuxtImport('useScanPolling', () => () => polling)

const progressPolling = {
  state: ref<ScanProgressView | null>(null),
  error: ref<string | null>(null),
  done: ref(false),
  start: vi.fn(),
  stop: vi.fn(),
}
mockNuxtImport('useScanProgressPolling', () => () => progressPolling)

// The header switcher reads the active site from useActiveSiteId(); mock it so
// the page's publish/clear watcher can be asserted directly.
const activeSiteId = ref<string | null>(null)
mockNuxtImport('useActiveSiteId', () => () => activeSiteId)

const ROUTE = '/scans/scan-1'

let activeWrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined

async function mountPage() {
  activeWrapper = await mountSuspended(ScanPage, { route: ROUTE })
  return activeWrapper
}

describe('pages/scans/[id]', () => {
  beforeEach(() => {
    polling.start.mockReset()
    polling.stop.mockReset()
    polling.state.value = null
    polling.done.value = false
    polling.error.value = null
    progressPolling.start.mockReset()
    progressPolling.stop.mockReset()
    progressPolling.state.value = null
    progressPolling.error.value = null
    activeSiteId.value = null
  })

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = undefined
  })

  it('starts polling on mount', async () => {
    await mountPage()
    expect(polling.start).toHaveBeenCalled()
  })

  it('publishes the scan siteId to the header active-site state and clears it when the scan is unavailable', async () => {
    polling.state.value = scanDetailFixture({ siteId: 'site-42' })
    await mountPage()
    expect(activeSiteId.value).toBe('site-42')

    // A failed reload / in-flight navigation drops the scan — the header must
    // not keep showing the previous site.
    polling.state.value = null
    await nextTick()
    expect(activeSiteId.value).toBeNull()
  })

  it('shows ScanProgress while the scan is queued or running', async () => {
    polling.state.value = scanDetailFixture({ status: 'running' })
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('Scanning')
    expect(wrapper.find('[data-testid="engine-run-panel"]').exists()).toBe(false)
  })

  it('lists every engine of a running scan in run order, started or not (#84)', async () => {
    polling.state.value = scanDetailFixture({
      status: 'running',
      engines: ['nuclei', 'zap-fe'],
      engineRuns: [
        engineRunFixture({
          id: 'run-fe',
          engine: 'zap-fe',
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: null,
        }),
      ],
      now: '2026-01-01T00:02:00.000Z',
    })
    const wrapper = await mountPage()

    // scan-level elapsed also follows the server clock (startedAt 00:00 → now 00:02)
    expect(wrapper.find('[data-testid="scan-elapsed"]').text()).toBe('Elapsed 2m 00s')
    const rows = wrapper.findAll('[data-testid="engine-run-timing"]')
    expect(rows.map((r: (typeof rows)[number]) => r.attributes('data-engine'))).toEqual([
      'zap-fe',
      'nuclei',
    ])
    expect(rows[0]!.find('[data-testid="engine-status-pill"]').text()).toBe('running')
    expect(rows[0]!.find('[data-testid="engine-elapsed"]').text()).toBe('Elapsed 2m 00s')
    expect(rows[1]!.find('[data-testid="engine-status-pill"]').text()).toBe('pending')
  })

  it('shows a queued placeholder before the first poll response arrives', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('Queued')
  })

  it('shows one EngineRunPanel per run and a markdown download link when finished', async () => {
    polling.state.value = scanDetailFixture({
      status: 'done',
      engineRuns: [
        engineRunFixture({ id: 'run-nuclei', engine: 'nuclei' }),
        engineRunFixture({ id: 'run-zap', engine: 'zap-fe' }),
      ],
      findings: [
        findingFixture({ id: 'f-nuclei', engine: 'nuclei' }),
        findingFixture({ id: 'f-zap', engine: 'zap-fe' }),
      ],
    })
    const wrapper = await mountPage()

    const panels = wrapper.findAll('[data-testid="engine-run-panel"]')
    expect(panels).toHaveLength(2)

    const link = wrapper.find('a[href="/api/scans/scan-1/report.md"]')
    expect(link.exists()).toBe(true)
  })

  it('shows the polling error instead of the progress or report views', async () => {
    polling.done.value = true
    polling.error.value = 'scan not found'
    const wrapper = await mountPage()

    expect(wrapper.find('[data-testid="poll-error"]').text()).toContain('scan not found')
    expect(wrapper.find('[data-testid="engine-run-panel"]').exists()).toBe(false)
  })

  it('surfaces the scan-level error when the overall scan failed', async () => {
    polling.state.value = scanDetailFixture({ status: 'failed', error: 'zap-fe crashed' })
    polling.done.value = true
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('zap-fe crashed')
  })

  describe('intrusion visualizer', () => {
    it('runs the live-progress poll only once the scan is running, and stops it at the end', async () => {
      polling.state.value = scanDetailFixture({ status: 'queued' })
      await mountPage()
      expect(progressPolling.start).not.toHaveBeenCalled()

      polling.state.value = scanDetailFixture({ status: 'running' })
      await nextTick()
      expect(progressPolling.start).toHaveBeenCalledTimes(1)

      polling.state.value = scanDetailFixture({ status: 'done' })
      await nextTick()
      expect(progressPolling.stop).toHaveBeenCalled()
    })

    it('says so when live progress is unavailable', async () => {
      polling.state.value = scanDetailFixture({ status: 'running' })
      progressPolling.error.value = 'boom'
      const wrapper = await mountPage()
      expect(wrapper.find('[data-testid="intrusion"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="progress-unavailable"]').exists()).toBe(true)
    })

    it('plays SCAN COMPLETE above the report when the scan finishes while watched, until closed', async () => {
      polling.state.value = scanDetailFixture({ status: 'running' })
      const wrapper = await mountPage()
      polling.state.value = scanDetailFixture({ status: 'done' })
      await nextTick()

      expect(wrapper.find('[data-testid="scan-finale"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="intrusion-outcome"]').text()).toBe('Scan complete')
      expect(wrapper.findAll('[data-testid="engine-run-panel"]').length).toBeGreaterThan(0)

      await wrapper.find('[data-testid="scan-finale"] button').trigger('click')
      expect(wrapper.find('[data-testid="scan-finale"]').exists()).toBe(false)
    })

    it('plays CONNECTION LOST when the watched scan fails', async () => {
      polling.state.value = scanDetailFixture({ status: 'running' })
      const wrapper = await mountPage()
      polling.state.value = scanDetailFixture({ status: 'failed' })
      await nextTick()
      expect(wrapper.find('[data-testid="intrusion-outcome"]').text()).toBe('Connection lost')
    })

    it('opening an already finished scan shows no finale', async () => {
      polling.state.value = scanDetailFixture({ status: 'done' })
      const wrapper = await mountPage()
      expect(wrapper.find('[data-testid="scan-finale"]').exists()).toBe(false)
    })
  })
})
