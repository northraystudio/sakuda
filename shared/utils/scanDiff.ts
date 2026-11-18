import type { Engine, ScanDiff } from '../types/api'
import { ENGINES } from './engines'

/** Engines whose findings were compared against a scan older than the
 * previous one, because the previous scan did not run them (#90) — what the
 * page and the report mention so the comparison is not misread. */
export function olderBaselines(
  diff: Pick<ScanDiff, 'previousScanId' | 'baselineScanIds'>,
): Array<{ engine: Engine; scanId: string }> {
  const out: Array<{ engine: Engine; scanId: string }> = []
  for (const engine of ENGINES) {
    const scanId = diff.baselineScanIds[engine]
    if (scanId && scanId !== diff.previousScanId) out.push({ engine, scanId })
  }
  return out
}
