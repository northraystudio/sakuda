import { claimNextQueuedDiscovery } from './discoveryService'
import { runDiscovery, type DiscoveryRunnerDeps } from './discoveryRunner'
import { claimNextQueuedScan } from './scanService'
import { runScan, USER_CANCEL_REASON, type ScanRunnerDeps } from './scanRunner'

export interface JobLoop {
  start(): void
  stop(): Promise<void>
  isBusy(): boolean
  /** Stops the scan if it is the one running now (#74). True when the stop
   * was signalled; false when that scan is not running in this loop. */
  cancelScan(scanId: string): boolean
}

export type JobLoopDeps = ScanRunnerDeps & DiscoveryRunnerDeps & { pollMs: number }

/** Single sequential worker over two queues. Scans are claimed before
 * discoveries so a queued scan is never starved by repeated discoveries;
 * within a queue, oldest first. */
let registered: JobLoop | null = null

/** Makes the running loop reachable from API routes (set once at boot). */
export function registerJobLoop(loop: JobLoop | null): void {
  registered = loop
}

/** The loop started at boot, or null when the job runner is off. */
export function getJobLoop(): JobLoop | null {
  return registered
}

export function createJobLoop(deps: JobLoopDeps): JobLoop {
  const ac = new AbortController()
  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let stopped = false
  let runningScan: { id: string; ac: AbortController } | null = null

  function claimNext(): (() => Promise<void>) | null {
    const scanId = claimNextQueuedScan(deps.db, deps.now)
    if (scanId)
      return () => {
        // Per-scan controller so a user stop ends this scan only; the
        // loop-wide one still stops it on shutdown.
        const scanAc = new AbortController()
        runningScan = { id: scanId, ac: scanAc }
        return runScan(deps, scanId, AbortSignal.any([ac.signal, scanAc.signal]))
          .catch((e: unknown) => deps.logger.error({ scanId, err: e }, 'runScan crashed'))
          .finally(() => {
            runningScan = null
          })
      }
    const discoveryId = claimNextQueuedDiscovery(deps.db, deps.now)
    if (discoveryId)
      return () =>
        runDiscovery(deps, discoveryId, ac.signal).catch((e: unknown) =>
          deps.logger.error({ discoveryId, err: e }, 'runDiscovery crashed'),
        )
    return null
  }

  async function tick(): Promise<void> {
    if (stopped) return
    const job = claimNext()
    if (job) {
      current = job()
      await current
      current = null
    }
    if (!stopped) timer = setTimeout(() => void tick(), job ? 0 : deps.pollMs)
  }

  return {
    start() {
      stopped = false
      timer = setTimeout(() => void tick(), 0)
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      ac.abort()
      await current
    },
    isBusy: () => current !== null,
    cancelScan(scanId) {
      if (runningScan?.id !== scanId) return false
      runningScan.ac.abort(USER_CANCEL_REASON)
      return true
    },
  }
}
