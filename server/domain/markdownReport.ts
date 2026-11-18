import type {
  EngineRunView,
  FindingView,
  ScanDetail,
  ScanDiff,
  UnverifiedReason,
  Severity,
  SeverityCounts,
} from '#shared/types/api'
import { addCounts, emptyCounts, REPORTED_SEVERITIES } from '#shared/utils/severity'
import { olderBaselines } from '#shared/utils/scanDiff'
import { engineMetaTable } from './markdownEngineMeta'
import { code, fence, fmtDuration, metaStringArray, text } from './markdownHelpers'

const MAX_URLS = 60
const MAX_EVIDENCE_CHARS = 120
const MAX_REF_LINES = 3

function firstLine(s: string | null | undefined): string {
  return text((s ?? '').split(/\r?\n/)[0])
}

// ---------- top-level sections ----------

export function buildScanMarkdown(detail: ScanDetail): string {
  const date = (detail.finishedAt ?? detail.createdAt).slice(0, 10)
  const lines: string[] = [`# sakuda Scan Report — ${text(detail.siteName)} — ${date}`, '']
  lines.push(...scanMetadataSection(detail), '')
  lines.push(...summarySection(detail), '')
  lines.push(...diffSection(detail.diff), '')
  for (const run of detail.engineRuns) {
    const findings = detail.findings.filter((f) => f.engine === run.engine)
    lines.push(...engineSection(run, findings), '')
  }
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  )
}

function scanMetadataSection(detail: ScanDetail): string[] {
  const snap = detail.siteSnapshot
  const durationSec =
    detail.startedAt && detail.finishedAt
      ? Math.round(
          (new Date(detail.finishedAt).getTime() - new Date(detail.startedAt).getTime()) / 1000,
        )
      : undefined
  return [
    '## Scan metadata',
    '',
    '| Item | Value |',
    '|---|---|',
    `| Site | ${text(detail.siteName)} |`,
    `| Front base URL | ${code(snap.frontBaseUrl)} |`,
    `| API base URL | ${snap.apiBaseUrl ? code(snap.apiBaseUrl) : '—'} |`,
    `| Engines | ${text(detail.engines.join(', '))} |`,
    `| Status | ${text(detail.status)} |`,
    `| Started at | ${detail.startedAt ? text(detail.startedAt) : '—'} |`,
    `| Finished at | ${detail.finishedAt ? text(detail.finishedAt) : '—'} |`,
    `| Duration | ${fmtDuration(durationSec)} |`,
    `| Scan id | ${code(detail.id)} |`,
  ]
}

function countsRow(label: string, c: SeverityCounts): string {
  return `| ${label} | ${c.critical} | ${c.high} | ${c.medium} | ${c.low} | ${c.info} |`
}

function summarySection(detail: ScanDetail): string[] {
  const rows = detail.engineRuns.map((run) => countsRow(text(run.engine), run.counts))
  const total = detail.engineRuns.reduce((acc, run) => addCounts(acc, run.counts), emptyCounts())
  return [
    '## Summary',
    '',
    '| Engine | Critical | High | Medium | Low | Info |',
    '|---|---|---|---|---|---|',
    ...rows,
    countsRow('**Total**', total),
  ]
}

const UNVERIFIED_REASON_TEXT: Record<UnverifiedReason, string> = {
  'engine-not-run': 'engine did not run',
  'url-not-reached': 'URL not reached',
  'reach-unknown': 'no record of the URLs reached',
}

function diffSection(diff: ScanDiff | null): string[] {
  const out = ['## Changes vs previous scan', '']
  if (!diff) {
    out.push('No previous scan to compare against.')
    return out
  }
  out.push(
    `New: ${diff.newCount}`,
    `Persisting: ${diff.persistingCount}`,
    `Resolved: ${diff.resolved.length}`,
    `Not checked this time: ${diff.unverified.length}`,
  )
  const older = olderBaselines(diff)
  if (older.length > 0)
    out.push(
      '',
      `The previous scan did not run every engine. Compared with the engine's last finished scan: ${older
        .map(({ engine, scanId }) => `${text(engine)} (${code(scanId)})`)
        .join(', ')}`,
    )
  if (diff.resolved.length > 0) {
    out.push('', '### Resolved (checked, no longer detected)', '')
    for (const f of diff.resolved)
      out.push(`- ${text(f.ruleId)} — ${text(f.name)} — ${code(f.url)}`)
  }
  if (diff.unverified.length > 0) {
    out.push('', '### Not checked this time (may still be present)', '')
    for (const f of diff.unverified)
      out.push(
        `- ${text(f.ruleId)} — ${text(f.name)} — ${code(f.url)} — ${text(f.engine)}: ${UNVERIFIED_REASON_TEXT[f.unverifiedReason]}`,
      )
  }
  return out
}

// ---------- per-engine section ----------

function engineSection(run: EngineRunView, findings: FindingView[]): string[] {
  const out = [`## ${run.engine}`, '', `**Status**: ${text(run.status)}`, '']
  out.push(...engineMetaTable(run), '')
  for (const w of run.warnings) out.push(`> Warning: ${text(w)}`)
  if (run.warnings.length > 0) out.push('')
  if (run.status === 'failed') {
    out.push('Status: failed', '')
    out.push(...fence(run.error ?? 'unknown error'), '')
  }
  out.push(...findingsBlock(findings))
  if (run.engine === 'zap-fe') out.push(...reachedUrlsBlock(run.meta))
  return out
}

// ---------- findings ----------

function findingsBlock(findings: FindingView[]): string[] {
  const bySeverity = new Map<Severity, FindingView[]>()
  for (const sev of REPORTED_SEVERITIES) bySeverity.set(sev, [])
  for (const f of findings) bySeverity.get(f.severity)?.push(f)

  const any = [...bySeverity.values()].some((v) => v.length > 0)
  if (!any) return ['No findings.', '']

  const out: string[] = []
  for (const sev of REPORTED_SEVERITIES) {
    const items = bySeverity.get(sev)
    if (!items || items.length === 0) continue
    out.push(`### ${sev}`, '')
    for (const f of items) out.push(...findingBlock(f))
  }
  return out
}

function findingBlock(f: FindingView): string[] {
  const marker = f.isNew ? ' **NEW**' : ''
  const out = [`#### ${text(f.ruleId)} — ${text(f.name)}${marker}`, '']
  const method = f.method ? `${f.method} ` : ''
  out.push(`- **URL**: ${code(`${method}${f.url}`)}`)
  if (f.param) out.push(`- **Param**: ${code(f.param)}`)
  if (f.evidence) {
    const truncated = f.evidence.length > MAX_EVIDENCE_CHARS
    const snippet = f.evidence.slice(0, MAX_EVIDENCE_CHARS)
    out.push(`- **Evidence**: ${code(snippet)}${truncated ? '…' : ''}`)
  }
  if (f.description) out.push(`- ${firstLine(f.description)}`)
  if (f.solution) out.push(`- **Solution**: ${firstLine(f.solution)}`)
  if (f.reference) {
    const refs = f.reference
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(0, MAX_REF_LINES)
    if (refs.length > 0) out.push(`- Refs: ${refs.map((r) => text(r)).join(', ')}`)
  }
  out.push('')
  return out
}

function reachedUrlsBlock(meta: Record<string, unknown>): string[] {
  const urls = metaStringArray(meta, 'reachedUrls') ?? []
  const out = ['### Reached URLs', '']
  if (urls.length === 0) {
    out.push('No URLs reached.', '')
    return out
  }
  for (const u of urls.slice(0, MAX_URLS)) out.push(`- ${code(u)}`)
  if (urls.length > MAX_URLS) out.push(`- … ${urls.length - MAX_URLS} more`)
  out.push('')
  return out
}
