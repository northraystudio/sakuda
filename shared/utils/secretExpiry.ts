/** Secret-expiry helpers shared by the server (scan-start warning) and the
 * site page (warning next to Start scan) — #17. Pure, no Node APIs. */

/** `header:<name>` or `<kind>:<name>` (kind = localStorage / sessionStorage / cookie). */
export function secretKey(item: { kind: string; name: string } | { name: string }): string {
  return 'kind' in item ? `${item.kind}:${item.name}` : `header:${item.name}`
}

/** A login closer to its expiry than this is reported before a scan starts. */
export const SECRET_EXPIRY_SOON_MS = 60 * 60 * 1000

export interface SecretExpiryProblem {
  key: string
  expiresAt: string
  state: 'expired' | 'soon'
}

export function findExpiryProblems(
  expiries: Record<string, string>,
  now: Date,
  soonMs: number = SECRET_EXPIRY_SOON_MS,
): SecretExpiryProblem[] {
  const problems: SecretExpiryProblem[] = []
  for (const [key, expiresAt] of Object.entries(expiries)) {
    const left = Date.parse(expiresAt) - now.getTime()
    if (Number.isNaN(left)) continue
    if (left <= 0) problems.push({ key, expiresAt, state: 'expired' })
    else if (left <= soonMs) problems.push({ key, expiresAt, state: 'soon' })
  }
  return problems.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
}

/** Runbook-style message: which secret, when, and what to do. */
export function formatExpiryWarning(p: SecretExpiryProblem): string {
  const when = p.state === 'expired' ? `expired at ${p.expiresAt}` : `expires at ${p.expiresAt}`
  return `${p.key} ${when} — the scan may run logged out; capture or paste a fresh value in Edit site → Authentication`
}
