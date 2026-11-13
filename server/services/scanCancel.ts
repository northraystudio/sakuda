import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { scans } from '../db/schema'
import { ServiceError } from './errors'
import type { JobLoop } from './jobLoop'

/**
 * Asks the job loop to stop a running scan (#74). The stop is asynchronous:
 * the runner ends the current engine, keeps the findings already saved and
 * marks the scan `failed` with "cancelled by user". Calling it again while
 * the scan is still winding down is harmless.
 */
export function cancelRunningScan(
  db: Db,
  loop: Pick<JobLoop, 'cancelScan'> | null,
  scanId: string,
): void {
  const row = db.select({ status: scans.status }).from(scans).where(eq(scans.id, scanId)).get()
  if (!row) throw new ServiceError(404, 'SCAN_NOT_FOUND', `scan ${scanId} not found`)
  if (row.status !== 'running' || !loop?.cancelScan(scanId))
    throw new ServiceError(
      409,
      'SCAN_NOT_RUNNING',
      `scan ${scanId} is not running (status: ${row.status}) — only a running scan can be stopped`,
    )
}
