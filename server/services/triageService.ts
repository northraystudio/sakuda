import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { findingTriage, findings, scans, type FindingTriageRow } from '../db/schema'
import { ServiceError } from './errors'
import type { TriageInput } from '#shared/schemas/triage'
import type { FindingTriageView } from '#shared/types/api'

export interface TriageServiceDeps {
  db: Db
  now: () => Date
}

export interface TriageResult {
  siteId: string
  fingerprint: string
  triage: FindingTriageView
}

function toView(row: FindingTriageRow): FindingTriageView {
  return { status: row.status, reason: row.reason, updatedAt: row.updatedAt }
}

/** Fingerprint → verdict for one site: what the scan diff and the finding
 * views read. */
export function triageForSite(db: Db, siteId: string): Map<string, FindingTriageView> {
  const rows = db.select().from(findingTriage).where(eq(findingTriage.siteId, siteId)).all()
  return new Map(rows.map((r) => [r.fingerprint, toView(r)]))
}

/** Fingerprints that must not count as new: false-positive or accepted. */
export function suppressedFingerprints(
  triage: ReadonlyMap<string, FindingTriageView>,
): Set<string> {
  const result = new Set<string>()
  for (const [fingerprint, t] of triage) if (t.status !== 'confirmed') result.add(fingerprint)
  return result
}

/**
 * Records a verdict for the finding's site + fingerprint, so it applies to
 * every scan of the site that reports the same finding. Idempotent: the row
 * is upserted, and re-sending the same verdict leaves it as it was (the
 * timestamp only moves when status or reason changes).
 */
export function setTriage(deps: TriageServiceDeps, input: TriageInput): TriageResult {
  const finding = deps.db
    .select({ siteId: scans.siteId, fingerprint: findings.fingerprint })
    .from(findings)
    .innerJoin(scans, eq(findings.scanId, scans.id))
    .where(eq(findings.id, input.findingId))
    .get()
  if (!finding)
    throw new ServiceError(404, 'FINDING_NOT_FOUND', `finding ${input.findingId} not found`)

  const current = triageForSite(deps.db, finding.siteId).get(finding.fingerprint)
  if (current && current.status === input.status && current.reason === input.reason)
    return { ...finding, triage: current }

  const row: FindingTriageRow = {
    siteId: finding.siteId,
    fingerprint: finding.fingerprint,
    status: input.status,
    reason: input.reason,
    updatedAt: deps.now().toISOString(),
  }
  deps.db
    .insert(findingTriage)
    .values(row)
    .onConflictDoUpdate({
      target: [findingTriage.siteId, findingTriage.fingerprint],
      set: { status: row.status, reason: row.reason, updatedAt: row.updatedAt },
    })
    .run()
  return { ...finding, triage: toView(row) }
}
