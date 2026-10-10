import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError } from 'h3'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useScanPolling } from '~/composables/useScanPolling'
import type { ScanDetail } from '#shared/types/api'

function scanFixture(overrides: Partial<ScanDetail> = {}): ScanDetail {
  return {
    id: 'scan-1',
    siteId: 'site-1',
    status: 'running',
    engines: ['zap-fe'],
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    error: null,
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
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
    engineRuns: [],
    now: '2026-01-01T00:00:01.000Z',
    findings: [],
    diff: null,
    ...overrides,
  }
}

// `useScanPolling` calls the real auto-imported `$fetch`, whose ofetch
// instance is bound once at module-evaluation time — `vi.stubGlobal` cannot
// swap it out afterwards. `registerEndpoint` is the mechanism this codebase
// (and @nuxt/test-utils) actually uses to intercept those requests: it
// patches a live, per-request handler registry that the already-created
// `$fetch` instance consults on every call.
let unregister: (() => void) | undefined

function mockScanEndpoint(handler: () => ScanDetail | Promise<ScanDetail>) {
  unregister = registerEndpoint('/api/scans/scan-1', handler)
}

/** Sequences responses across successive polls: call N gets `responses[N]`,
 * clamped to the last entry once exhausted. */
function sequencedScanEndpoint(responses: Array<() => ScanDetail>) {
  let call = 0
  mockScanEndpoint(() => {
    const factory = responses[Math.min(call, responses.length - 1)]
    call += 1
    if (!factory) throw new Error('sequencedScanEndpoint: no response factory configured')
    return factory()
  })
}

/** The mocked `$fetch` round-trip resolves across two microtask turns under
 * fake timers (an internal fetch-layer hop that a single
 * `advanceTimersByTimeAsync(0)` doesn't flush) — advance the clock by `ms`
 * and then flush twice so any fetch armed by that tick has settled before
 * assertions run. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

describe('useScanPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    unregister?.()
    unregister = undefined
  })

  it('stops polling once status transitions from running to done', async () => {
    let calls = 0
    sequencedScanEndpoint([
      () => {
        calls++
        return scanFixture({ status: 'running' })
      },
      () => {
        calls++
        return scanFixture({ status: 'done', finishedAt: '2026-01-01T00:05:00.000Z' })
      },
    ])

    const polling = useScanPolling('scan-1', { intervalMs: 1000 })
    polling.start()
    await advance(0)
    expect(polling.state.value?.status).toBe('running')
    expect(polling.done.value).toBe(false)

    await advance(1000)
    expect(polling.state.value?.status).toBe('done')
    expect(polling.done.value).toBe(true)
    expect(calls).toBe(2)

    await advance(5000)
    expect(calls).toBe(2) // no further polling once done
  })

  it('sets done when the scan status is failed', async () => {
    mockScanEndpoint(() => scanFixture({ status: 'failed', error: 'engine crashed' }))

    const polling = useScanPolling('scan-1', { intervalMs: 1000 })
    polling.start()
    await advance(0)

    expect(polling.done.value).toBe(true)
    expect(polling.state.value?.status).toBe('failed')
  })

  it('sets error and stops when the fetch rejects', async () => {
    mockScanEndpoint(() => {
      throw createError({ statusCode: 404, statusMessage: 'scan not found' })
    })

    const polling = useScanPolling('scan-1', { intervalMs: 1000 })
    polling.start()
    await advance(0)

    expect(polling.error.value).toBe('scan not found')
    expect(polling.done.value).toBe(true)
  })

  it('polls at the default 2500ms interval when opts is omitted', async () => {
    let calls = 0
    sequencedScanEndpoint([
      () => {
        calls++
        return scanFixture({ status: 'running' })
      },
      () => {
        calls++
        return scanFixture({ status: 'done' })
      },
    ])

    const polling = useScanPolling('scan-1')
    polling.start()
    await advance(0)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(2499) // not due yet — no extra flush needed
    expect(calls).toBe(1)
    await advance(1)
    expect(calls).toBe(2)
    expect(polling.done.value).toBe(true)
  })

  it('stop() prevents any further scheduled calls', async () => {
    let calls = 0
    mockScanEndpoint(() => {
      calls++
      return scanFixture({ status: 'running' })
    })

    const polling = useScanPolling('scan-1', { intervalMs: 1000 })
    polling.start()
    await advance(0)
    polling.stop()

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)
  })

  it('ignores an in-flight result when stopped before it resolves', async () => {
    let calls = 0
    let resolveFetch!: (value: ScanDetail) => void
    mockScanEndpoint(
      () =>
        new Promise<ScanDetail>((resolve) => {
          calls++
          resolveFetch = resolve
        }),
    )

    const polling = useScanPolling('scan-1', { intervalMs: 1000 })
    polling.start()
    await advance(0) // request is in flight
    polling.stop() // unmount-equivalent stop before the response arrives

    resolveFetch(scanFixture({ status: 'running' }))
    await advance(5000)

    expect(calls).toBe(1) // no reschedule
    expect(polling.state.value).toBeNull() // stopped result is discarded
    expect(polling.done.value).toBe(false)
  })

  it('stops the existing timer chain when start() is called again', async () => {
    let calls = 0
    mockScanEndpoint(() => {
      calls++
      return scanFixture({ status: 'running' })
    })

    const polling = useScanPolling('scan-1', { intervalMs: 1000 })
    polling.start()
    await advance(0)
    polling.start() // re-entrant start must not create a second polling chain
    await advance(0)
    await advance(1000)

    expect(calls).toBe(3)
  })

  it('discards an in-flight result from a previous run after start() is called again', async () => {
    // Run 1's request is left pending; start() begins run 2, whose request
    // resolves first. When run 1's stale response finally arrives it must
    // neither overwrite state nor schedule a second polling chain.
    let calls = 0
    const pending: Array<(value: ScanDetail) => void> = []
    mockScanEndpoint(
      () =>
        new Promise<ScanDetail>((resolve) => {
          calls++
          pending.push(resolve)
        }),
    )

    const polling = useScanPolling('scan-1', { intervalMs: 1000 })
    polling.start()
    await advance(0) // run 1 in flight
    polling.start() // run 2
    await advance(0) // run 2 in flight
    expect(calls).toBe(2)

    pending[1]?.(scanFixture({ status: 'done' })) // run 2 finishes → terminal
    await advance(0)
    expect(polling.done.value).toBe(true)

    pending[0]?.(scanFixture({ status: 'running' })) // stale run 1 arrives late
    await advance(0)
    expect(polling.state.value?.status).toBe('done') // not overwritten
    await advance(5000)
    expect(calls).toBe(2) // no resurrected chain
  })

  it('stops automatically when the owning component unmounts', async () => {
    let calls = 0
    mockScanEndpoint(() => {
      calls++
      return scanFixture({ status: 'running' })
    })
    let handle!: ReturnType<typeof useScanPolling>
    const Harness = defineComponent({
      setup() {
        handle = useScanPolling('scan-1', { intervalMs: 1000 })
        handle.start()
        return () => h('div')
      },
    })

    const wrapper = mount(Harness)
    await advance(0)
    wrapper.unmount()
    await advance(5000)

    expect(calls).toBe(1)
  })
})
