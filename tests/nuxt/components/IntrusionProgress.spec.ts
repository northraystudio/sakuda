import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import IntrusionProgress from '~/components/scan/IntrusionProgress.vue'
import { engineRunFixture } from '../helpers/fixtures'

let nextId = 1
const raf = vi.fn((_cb: FrameRequestCallback) => nextId++)
const caf = vi.fn((_id: number) => {})

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
}

const runningProps = {
  status: 'running',
  startedAt: '2026-01-01T00:00:00.000Z',
  engines: ['nuclei' as const],
  engineRuns: [engineRunFixture({ status: 'running', finishedAt: null })],
  serverNow: '2026-01-01T00:01:00.000Z',
}

describe('IntrusionProgress', () => {
  beforeEach(() => {
    raf.mockClear()
    caf.mockClear()
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', caf)
    stubReducedMotion(false)
    setHidden(false)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setHidden(false)
  })

  it('mounts with the HUD for the running engine and starts one frame loop', async () => {
    const wrapper = await mountSuspended(IntrusionProgress, { props: runningProps })
    expect(wrapper.find('canvas').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('[data-testid="intrusion-engine"]').text()).toBe('Nuclei')
    expect(wrapper.find('[data-testid="intrusion-phase"]').text()).toBe('Phase 1/1')
    expect(wrapper.find('[data-testid="intrusion-elapsed"]').text()).toBe('1m 00s')
    expect(wrapper.find('[data-testid="intrusion"]').attributes('data-looping')).toBe('true')
    expect(raf).toHaveBeenCalledTimes(1) // never two loops at once
    wrapper.unmount()
  })

  it("shows the running engine's current stage from live progress", async () => {
    const wrapper = await mountSuspended(IntrusionProgress, {
      props: {
        ...runningProps,
        progress: { engine: 'nuclei', percent: 40, matched: 1, stage: 'signature' },
      },
    })
    expect(wrapper.find('[data-testid="intrusion-stage"]').text()).toBe('signature')
    wrapper.unmount()
  })

  it('cancels its frame on unmount', async () => {
    const wrapper = await mountSuspended(IntrusionProgress, { props: runningProps })
    const id = raf.mock.results.at(-1)!.value as number
    wrapper.unmount()
    expect(caf).toHaveBeenCalledWith(id)
  })

  it('stops while the tab is hidden and resumes when visible', async () => {
    const wrapper = await mountSuspended(IntrusionProgress, { props: runningProps })
    setHidden(true)
    await nextTick()
    expect(caf).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="intrusion"]').attributes('data-looping')).toBe('false')
    raf.mockClear()
    setHidden(false)
    await nextTick()
    expect(raf).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('reduced motion: draws still frames, never schedules a loop', async () => {
    stubReducedMotion(true)
    const wrapper = await mountSuspended(IntrusionProgress, { props: runningProps })
    expect(raf).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="intrusion"]').attributes('data-looping')).toBe('false')
    wrapper.unmount()
  })

  it('shows SCAN COMPLETE / CONNECTION LOST for a finished scan', async () => {
    const clear = await mountSuspended(IntrusionProgress, {
      props: { ...runningProps, status: 'done', engineRuns: [engineRunFixture()] },
    })
    expect(clear.find('[data-testid="intrusion-outcome"]').text()).toBe('Scan complete')
    expect(clear.find('[data-testid="intrusion-elapsed"]').exists()).toBe(false)
    clear.unmount()

    const over = await mountSuspended(IntrusionProgress, {
      props: {
        ...runningProps,
        status: 'failed',
        engineRuns: [engineRunFixture({ status: 'failed' })],
      },
    })
    expect(over.find('[data-testid="intrusion-outcome"]').text()).toBe('Connection lost')
    over.unmount()
  })
})
