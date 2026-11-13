import type { Header } from '#shared/schemas/headers'

export interface DalfoxConfigInput {
  headers: Header[]
  /** Global outbound request-rate cap (req/s); 0 = unlimited. */
  rateLimit: number
  /** Worker count and concurrent-target cap (kept small on purpose). */
  concurrency: number
  /** Cap on saved targets consumed per run and the per-host cap. */
  maxTargets: number
  /** Hard per-target wall-clock cap (seconds) for the scan stage. */
  scanTimeoutSec: number
}

/** Share of the whole budget one target may use. Measured on Juice Shop (50
 * targets, 10 concurrent, 600 s budget, #67): 120 s cut 10 targets short,
 * 240 s still 2–3, 360 s none — and the whole run took 358 s. */
const PER_TARGET_BUDGET_SHARE = 0.6

/**
 * dalfox's per-target `scan_timeout` (seconds). The per-wave share
 * (`budget / ceil(targets / concurrency)`) assumes every wave runs to its cap,
 * but dalfox refills a free slot with the next target, so the run ends far
 * earlier and that share needlessly cuts slow targets short. A target may
 * therefore also use PER_TARGET_BUDGET_SHARE of the budget — whichever is
 * larger, so the cap never drops below the per-wave share. The whole run is
 * still hard-killed at the total budget by runCommand.
 */
export function dalfoxScanTimeoutSec(
  totalBudgetSec: number,
  targetCount: number,
  concurrency: number,
): number {
  const waves = Math.max(1, Math.ceil(targetCount / concurrency))
  return Math.max(
    15,
    Math.floor(totalBudgetSec / waves),
    Math.floor(totalBudgetSec * PER_TARGET_BUDGET_SHARE),
  )
}

/**
 * The dalfox JSON config document. dalfox v3.3.0 (as v3.2.2) accepts a TOML or JSON config
 * whose keys live under a `scan` table and mirror the CLI flags; secrets
 * (Authorization / Cookie headers) go here rather than on argv so they never
 * appear in the process list. The whole bounded profile is expressed here as
 * one audited surface: mining, deep scan, stored/blind XSS, remote payloads
 * and external-JS fetching are all disabled; the AST DOM-XSS pass (0 extra
 * requests) is left on because it is the reason to run dalfox at all.
 *
 * The returned object is written 0600 and removed after the run.
 */
export function buildDalfoxConfig(i: DalfoxConfigInput): { scan: Record<string, unknown> } {
  return {
    scan: {
      // secrets — kept off argv
      headers: i.headers.map((h) => `${h.name}: ${h.value}`),
      // bounded engine limits
      rate_limit: i.rateLimit,
      workers: i.concurrency,
      max_concurrent_targets: i.concurrency,
      max_targets_per_host: i.maxTargets,
      scan_timeout: i.scanTimeoutSec,
      follow_redirects: false,
      // discovery/mining: skip harvesting — rely on the saved parameterized targets
      skip_mining: true,
      // XSS surface: reflected + AST(DOM) only. No stored/blind, no deep scan,
      // no remote payload/wordlist sources, no external-JS fetching.
      deep_scan: false,
      sxss: false,
      only_custom_payload: false,
      remote_payloads: [],
      remote_wordlists: [],
      analyze_external_js: false,
      skip_ast_analysis: false,
    },
  }
}
