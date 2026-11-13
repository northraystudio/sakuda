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
