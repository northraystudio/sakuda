import type { ScanProgressView } from '#shared/types/api'

/** Polls `GET /api/scans/:id/progress` while the scan is running. The
 * visualizer falls back to time-based estimates when this is unavailable,
 * so a failed poll only stops this poll — `error` says so. */
export function useScanProgressPolling(scanId: string, opts: { intervalMs?: number } = {}) {
  return usePolling<ScanProgressView>(
    () => $fetch<ScanProgressView>(`/api/scans/${scanId}/progress`),
    (p) => p.status !== 'queued' && p.status !== 'running',
    opts,
  )
}
