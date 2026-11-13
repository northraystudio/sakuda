import { z } from 'zod'
import { emptyCounts, isReportedSeverity } from '#shared/utils/severity'
import type { SeverityCounts, SeverityLevel } from '#shared/types/api'
import type { NewFinding } from '../types'

/**
 * The subset of a dalfox JSON finding sakuda reads (dalfox v3.2.2–v3.3.0 `-f json`,
 * one object per element of the top-level `findings` array). `data` carries
 * the full URL the payload landed in — dalfox has no separate `url` key — and
 * `param` is the parameter name (`-` for an AST/DOM flow with no request
 * parameter). Unknown keys are ignored so a newer dalfox that adds fields
 * still parses.
 */
const DalfoxFindingSchema = z
  .object({
    type: z.string().default(''),
    inject_type: z.string().default(''),
    method: z.string().default(''),
    data: z.string().default(''),
    param: z.string().default(''),
    payload: z.string().default(''),
    evidence: z.string().default(''),
    cwe: z.string().default(''),
    severity: z.string().default(''),
    message_str: z.string().default(''),
    detection_method: z.string().optional(),
    confidence: z.string().optional(),
    confidence_reason: z.string().optional(),
  })
  .passthrough()

export type DalfoxFinding = z.infer<typeof DalfoxFindingSchema>

const DalfoxReportSchema = z
  .object({
    findings: z.array(z.unknown()).optional(),
    results: z.array(z.unknown()).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

export interface ParsedDalfoxReport {
  findings: DalfoxFinding[]
  meta: Record<string, unknown>
  /** Findings that were present but unparsable, so a partial report is not
   * silently read as fewer findings. */
  invalid: number
}

/** A dalfox target_summary entry we care about for reachability. */
interface DalfoxTargetSummary {
  status?: string
  error_code?: string
}

export interface DalfoxReachability {
  total: number
  unreachable: number
  /** True when every listed target failed to connect (or was skipped) — the
   * whole target set was down, not a real scan error. Distinguishes
   * "unavailable" from a genuine dalfox failure and from a clean zero. */
  allUnreachable: boolean
}

/**
 * Reads reachability from the scan-metadata envelope's `target_summary`. A
 * target is "unreachable" only when dalfox attached a non-empty `error_code`
 * (e.g. CONNECTION_FAILED) — a connection/transport failure it never got past.
 * A bare `status: "skipped"` with no error code is NOT counted: a target
 * skipped for some other reason must not let a genuine exit-2 error be
 * downgraded to a warning.
 */
export function dalfoxReachability(meta: Record<string, unknown>): DalfoxReachability {
  const raw = meta.target_summary
  const list: DalfoxTargetSummary[] = Array.isArray(raw) ? (raw as DalfoxTargetSummary[]) : []
  const unreachable = list.filter(
    (t) => t != null && typeof t.error_code === 'string' && t.error_code.trim() !== '',
  ).length
  return {
    total: list.length,
    unreachable,
    allUnreachable: list.length > 0 && unreachable === list.length,
  }
}

/**
 * Per-target error codes that describe one target's outcome rather than a
 * failed run. dalfox exits 2 when any target carries one of them (both v3.2.2
 * and v3.3.0 do this for SESSION_LOST), even though the rest of the scan ran.
 * - CONTENT_TYPE_MISMATCH: skipped by design (a non-HTML response, e.g. a file)
 * - SCAN_TIMEOUT: cut short by the per-target `scan_timeout`
 * - SESSION_LOST: the target's preflight already looked unauthenticated
 */
const PER_TARGET_ERROR_CODES = new Set(['CONTENT_TYPE_MISMATCH', 'SCAN_TIMEOUT', 'SESSION_LOST'])

export interface DalfoxTargetOutcomes {
  /** error_code → target count, for targets dalfox did not finish testing
   * (every per-target code except the by-design CONTENT_TYPE_MISMATCH skip). */
  cutShort: Record<string, number>
  /** True when the report lists targets, at least one carries an error code,
   * and every error code is a known per-target outcome. An exit 2 with such a
   * report describes those targets, not a failed run. An unknown code keeps
   * this false, so a format drift or a new failure mode still fails loudly. */
  onlyPerTargetErrors: boolean
}

/** Reads per-target outcomes from the scan-metadata envelope's `target_summary`. */
export function dalfoxTargetOutcomes(meta: Record<string, unknown>): DalfoxTargetOutcomes {
  const raw = meta.target_summary
  const list: DalfoxTargetSummary[] = Array.isArray(raw) ? (raw as DalfoxTargetSummary[]) : []
  const codes = list
    .map((t) => (t != null && typeof t.error_code === 'string' ? t.error_code.trim() : ''))
    .filter((c) => c !== '')
  const cutShort: Record<string, number> = {}
  for (const c of codes) {
    if (c !== 'CONTENT_TYPE_MISMATCH') cutShort[c] = (cutShort[c] ?? 0) + 1
  }
  return {
    cutShort,
    onlyPerTargetErrors: codes.length > 0 && codes.every((c) => PER_TARGET_ERROR_CODES.has(c)),
  }
}

/** Parses dalfox's JSON document into typed findings + the scan-metadata
 * envelope. A malformed document yields an empty report with `invalid`
 * reflecting the count when it is an array of broken entries. */
export function parseDalfoxReport(json: string): ParsedDalfoxReport {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return { findings: [], meta: {}, invalid: 0 }
  }
  const outer = DalfoxReportSchema.safeParse(doc)
  if (!outer.success) return { findings: [], meta: {}, invalid: 0 }
  const rawList = outer.data.findings ?? outer.data.results ?? []
  const findings: DalfoxFinding[] = []
  let invalid = 0
  for (const item of rawList) {
    const parsed = DalfoxFindingSchema.safeParse(item)
    if (parsed.success) findings.push(parsed.data)
    else invalid++
  }
  return { findings, meta: outer.data.meta ?? {}, invalid }
}

/** dalfox confidence tiers we treat as XSS findings; `I` (informational /
 * outdated-library) is not an XSS claim and is dropped. */
const XSS_TIERS = new Set(['V', 'A', 'R'])

/**
 * Maps a dalfox tier to a sakuda severity by verification confidence:
 * `V` (verified in a headless browser) → `high`; `A` (an AST source-to-sink
 * flow — statically identified, browser-unverified) → `medium`; `R`
 * (reflection only — the payload came back in the response but nothing
 * confirmed it executes) → `low`. A reflection-only signal is the weakest
 * tier: dalfox greps the response and cannot see the output context, so a
 * payload echoed into a non-executing place (an error page `<title>`, a JSON
 * body) reads the same as a real one. Keeping `R` below the reported floor
 * (see REPORTED_SEVERITIES) stops those unverified signals from surfacing as
 * medium XSS findings, while `normalizeDalfoxFindings` still counts them so
 * they are visible, not suppressed.
 */
export function dalfoxSeverity(tier: string): SeverityLevel {
  return tier === 'V' ? 'high' : tier === 'A' ? 'medium' : 'low'
}

/** The detection method, falling back from the tier when dalfox omits it, so
 * the fingerprint ruleId is stable and never payload-derived. */
function methodOf(f: DalfoxFinding): string {
  if (f.detection_method && f.detection_method.trim() !== '') return f.detection_method
  return f.type === 'A' ? 'ast' : f.type === 'R' ? 'reflection' : 'dom-verification'
}

const TIER_NAME: Record<string, string> = {
  V: 'Cross-Site Scripting (verified)',
  A: 'DOM-based XSS (AST source-to-sink)',
  R: 'Reflected input (unverified XSS signal)',
}

const XSS_SOLUTION =
  'Treat the parameter/URL as untrusted: render it as text or encode it for its output context, and rely on the framework escaping rather than assigning to innerHTML / document.write.'

/** Normalizes dalfox's parsed findings to `NewFinding[]` + counts. `unalias`
 * restores a rewritten loopback host in the reported URL. Findings that are
 * not XSS tiers, or that map to a non-reported severity, are dropped. */
export function normalizeDalfoxFindings(
  findings: DalfoxFinding[],
  unalias: (u: string) => string,
): { findings: NewFinding[]; counts: SeverityCounts } {
  const out: NewFinding[] = []
  const counts = emptyCounts()
  for (const f of findings) {
    if (!XSS_TIERS.has(f.type)) continue
    const level: SeverityLevel = dalfoxSeverity(f.type)
    // Count every XSS-tier signal — reflection-only (`R` → low) included — so
    // it stays visible in the severity counts. Below the reported floor it is
    // not emitted as a detailed finding (same as any low/info), but it is
    // never silently dropped.
    counts[level]++
    if (!isReportedSeverity(level)) continue
    const method = methodOf(f)
    const param = f.param === '' || f.param === '-' ? null : f.param
    const cwe = f.cwe || 'CWE-79'
    const cweId = /(\d+)/.exec(cwe)?.[1] ?? '79'
    const descriptionParts = [
      f.message_str || TIER_NAME[f.type] || 'Cross-Site Scripting',
      f.inject_type ? `Context: ${f.inject_type}.` : '',
      f.confidence ? `Confidence: ${f.confidence}.` : '',
      f.confidence_reason ? f.confidence_reason : '',
    ].filter((p) => p !== '')
    out.push({
      engine: 'dalfox',
      ruleId: `dalfox:${method}`,
      name: f.message_str || TIER_NAME[f.type] || 'Cross-Site Scripting',
      severity: level,
      url: unalias(f.data),
      method: f.method || null,
      param,
      evidence: f.evidence || null,
      description: descriptionParts.join(' '),
      solution: XSS_SOLUTION,
      reference: `https://cwe.mitre.org/data/definitions/${cweId}.html`,
      raw: { ...f, data: unalias(f.data) },
    })
  }
  return { findings: out, counts }
}
