import { z } from 'zod'
import { emptyCounts, isReportedSeverity, SEVERITY_LEVELS } from '#shared/utils/severity'
import type { SeverityCounts, SeverityLevel } from '#shared/types/api'
import type { NewFinding } from '../types'

export const NucleiLineSchema = z.looseObject({
  'template-id': z.string(),
  info: z.looseObject({
    name: z.string().default(''),
    severity: z.string().default('unknown'),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    reference: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
  }),
  type: z.string().optional(),
  host: z.string().optional(),
  'matched-at': z.string().optional(),
  'matcher-name': z.string().optional(),
  'extracted-results': z.array(z.string()).optional(),
  request: z.string().optional(),
  response: z.string().optional(),
  timestamp: z.string().optional(),
  /** Set when the match is an interactsh (OAST) callback (#35). Only
   * protocol / remote-address / timestamp are ever persisted; the ids are
   * read only to mask them, and raw-request/raw-response are dropped. */
  interaction: z
    .looseObject({
      protocol: z.string().optional(),
      'unique-id': z.string().optional(),
      'full-id': z.string().optional(),
      'remote-address': z.string().optional(),
      timestamp: z.string().optional(),
    })
    .optional(),
})
export type NucleiLine = z.infer<typeof NucleiLineSchema>

export interface NucleiStats {
  duration?: string
  errors?: string
  hosts?: string
  matched?: string
  /** Percent of planned requests executed (`-stats-json`); below 100 at exit
   * means nuclei stopped early. */
  percent?: string
  requests?: string
  rps?: string
  templates?: string
  total?: string
}

export function parseNucleiJsonl(text: string): { lines: NucleiLine[]; invalidLines: number } {
  const lines: NucleiLine[] = []
  let invalidLines = 0
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l) continue
    // boundary: one malformed line must not kill the run — counted and surfaced as a warning
    try {
      const r = NucleiLineSchema.safeParse(JSON.parse(l))
      if (r.success) lines.push(r.data)
      else invalidLines++
    } catch {
      invalidLines++
    }
  }
  return { lines, invalidLines }
}

export function parseNucleiStats(logText: string): NucleiStats | null {
  for (const c of logText
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .reverse()) {
    try {
      const j: unknown = JSON.parse(c)
      // as: shape guarded by the 'requests' in j check above; every NucleiStats field is an
      // optional string, so a partial/malformed object still satisfies the type at runtime.
      if (typeof j === 'object' && j && 'requests' in j) return j as NucleiStats
    } catch {
      /* not a stats line */
    }
  }
  return null
}

/**
 * A nuclei command-injection match made only by response timing (`matcher-name`
 * "time-based") with no extracted command output is unverified. A rate-limited
 * scan against a slow or variable-latency target produces timing false
 * positives: a `$(id)` / `&&whoami` that the app never runs still "delayed"
 * enough to trip the DSL duration check, so the generic cmdi templates flag
 * echo/error endpoints that have no command execution at all (observed against
 * Juice Shop, which has no OS-command-injection challenge). Such a match is not
 * a high confirmed finding.
 *
 * A cmdi match that extracted command output (`uid=…`, `root:x:…` in
 * `extracted-results`) is corroborated and is left at its template severity —
 * only the output-less, timing-only signal is demoted.
 */
export function isUnverifiedTimeBasedCmdi(l: NucleiLine): boolean {
  const tags = l.info.tags ?? []
  const noOutput = l['extracted-results'] === undefined || l['extracted-results'].length === 0
  return tags.includes('cmdi') && l['matcher-name'] === 'time-based' && noOutput
}

export function normalizeNucleiLines(
  lines: NucleiLine[],
  unalias: (u: string) => string,
): { findings: NewFinding[]; counts: SeverityCounts } {
  const counts = emptyCounts()
  const findings: NewFinding[] = []
  for (const l of lines) {
    const sev = l.info.severity.toLowerCase()
    // as: SEVERITY_LEVELS is typed as readonly SeverityLevel[]; widen to string[] so
    // .includes() can check an arbitrary lowercased severity string against it.
    const isKnownLevel = (SEVERITY_LEVELS as readonly string[]).includes(sev)
    // as: narrowed by the includes() check above — sev is one of SEVERITY_LEVELS when true.
    const templateLevel: SeverityLevel = isKnownLevel ? (sev as SeverityLevel) : 'info'
    // An unverified (timing-only) command-injection match is demoted to `low`:
    // below the reported floor so it never surfaces as a confirmed finding, but
    // still counted (never silently dropped) so the timing signal stays visible.
    const level: SeverityLevel = isUnverifiedTimeBasedCmdi(l) ? 'low' : templateLevel
    counts[level]++
    if (!isReportedSeverity(level)) continue
    const oast = l.interaction
    const url = maskOastIds(unalias(l['matched-at'] ?? l.host ?? ''), oast)
    const method = /^([A-Z]+) \S+ HTTP\//.exec(l.request ?? '')?.[1] ?? null
    const refs =
      l.info.reference == null
        ? null
        : (Array.isArray(l.info.reference) ? l.info.reference : [l.info.reference]).join('\n')
    findings.push({
      engine: 'nuclei',
      ruleId: l['template-id'],
      name: l.info.name,
      severity: level,
      url,
      method,
      param: null,
      evidence: oast
        ? oastEvidence(oast)
        : (l['extracted-results']?.join(', ') ?? l['matcher-name'] ?? null),
      description: l.info.description?.trim() ?? null,
      solution: null,
      reference: refs,
      // request/response are intentionally NOT stored here: nuclei is run with
      // -omit-raw (see args.ts), but even if that ever changed, these fields
      // can contain the site's injected auth headers (Cookie/Authorization)
      // verbatim and must never be persisted to disk/SQLite in plaintext.
      raw: {
        templateId: l['template-id'],
        type: l.type,
        host: l.host,
        tags: l.info.tags,
        matcherName: l['matcher-name'],
        timestamp: l.timestamp,
        ...(oast
          ? {
              oast: {
                protocol: oast.protocol,
                remoteAddress: oast['remote-address'],
                timestamp: oast.timestamp,
              },
            }
          : {}),
      },
    })
  }
  return { findings, counts }
}

type OastInteraction = NonNullable<NucleiLine['interaction']>

/** The callback is the proof for an OAST match: who reached the listener,
 * over what, and when (#35). */
function oastEvidence(i: OastInteraction): string {
  return `OAST ${i.protocol ?? 'unknown'} callback from ${i['remote-address'] ?? 'unknown'} at ${i.timestamp ?? 'unknown'}`
}

/** The injected payload in `matched-at` carries the interactsh correlation
 * id (`https://<id>.oast.pro`); it is never stored (#35). The full id is
 * replaced first because it may contain the unique id. */
function maskOastIds(url: string, i: OastInteraction | undefined): string {
  if (!i) return url
  let masked = url
  for (const id of [i['full-id'], i['unique-id']])
    if (id) masked = masked.replaceAll(id, '<oast-id>')
  return masked
}

/** Rewrites nuclei's JSONL so the retained artifact matches what sakuda
 * stores (#43): on lines with an `interaction`, drops `raw-request` /
 * `raw-response` and masks the correlation ids everywhere on the line (they
 * also appear in the payload URLs). Every other line — and any line that is
 * not JSON — is kept byte for byte. `changed` is false when nothing needed
 * rewriting, so the caller can skip the write. */
export function redactOastJsonl(text: string): { text: string; changed: boolean } {
  let changed = false
  const out = text.split('\n').map((line) => {
    if (!line.includes('"interaction"')) return line
    let parsed: unknown
    // boundary: an unparsable line is left untouched (parseNucleiJsonl counts it)
    try {
      parsed = JSON.parse(line)
    } catch {
      return line
    }
    if (!isRecord(parsed) || !isRecord(parsed.interaction)) return line
    const { 'raw-request': _req, 'raw-response': _res, ...interaction } = parsed.interaction
    const ids = {
      'full-id': stringOrUndefined(interaction['full-id']),
      'unique-id': stringOrUndefined(interaction['unique-id']),
    }
    changed = true
    return maskOastIds(JSON.stringify({ ...parsed, interaction }), ids)
  })
  return { text: out.join('\n'), changed }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export interface SkippedHost {
  host: string
  /** Error count at which nuclei dropped the host (its `-max-host-error` guard). */
  errors: number
}

// Not anchored to the `[INF]` prefix: a timestamp or logger prefix in front
// of the message (nuclei `-ts`, a log wrapper) must not turn a skipped host
// into a "clean" run.
const SKIPPED_HOST_RE = /Skipped (\S+) from target list as found unresponsive (\d+) times/

/**
 * Hosts nuclei removed from the scan mid-run because of its per-host error
 * guard (`-max-host-error`). nuclei logs the line once per template cluster
 * that hit the guard, so a host repeats; keep one entry per host with the
 * highest count. Every phase disables the guard (#82), so a hit here means
 * the flag was dropped or nuclei changed behaviour — either way the phase
 * did not cover its targets and must not be reported as "ran clean".
 */
export function parseSkippedHosts(logText: string): SkippedHost[] {
  const byHost = new Map<string, number>()
  for (const line of logText.split('\n')) {
    const m = SKIPPED_HOST_RE.exec(line.trim())
    if (!m) continue
    const host = m[1]!
    const errors = Number(m[2])
    byHost.set(host, Math.max(byHost.get(host) ?? 0, errors))
  }
  return [...byHost].map(([host, errors]) => ({ host, errors }))
}
