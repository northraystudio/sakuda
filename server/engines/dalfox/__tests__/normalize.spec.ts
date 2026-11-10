import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  dalfoxReachability,
  dalfoxSeverity,
  normalizeDalfoxFindings,
  parseDalfoxReport,
} from '../normalize'

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/dalfox-report.json', import.meta.url)),
  'utf8',
)
const identity = (u: string) => u

describe('parseDalfoxReport', () => {
  it('reads the findings array and the scan-metadata envelope', () => {
    const r = parseDalfoxReport(fixture)
    expect(r.findings).toHaveLength(3)
    expect(r.meta.total_requests).toBe(512)
    expect(r.meta.incomplete).toBe(false)
    expect(r.invalid).toBe(0)
  })

  it('falls back to a `results` array when `findings` is absent', () => {
    const r = parseDalfoxReport(
      JSON.stringify({ results: [{ type: 'V', data: 'http://x/', param: 'q' }] }),
    )
    expect(r.findings).toHaveLength(1)
  })

  it('parses a dalfox 3.3 finding that carries the newer `filter` fingerprint', () => {
    // dalfox 3.3.0 added a per-parameter `filter` object to every finding and
    // a `method` to `target_summary`; sakuda ignores both but must still parse.
    const r = parseDalfoxReport(
      JSON.stringify({
        meta: {
          dalfox_version: '3.3.0',
          target_summary: [{ url: 'http://x/?q=', method: 'GET', status: 'findings' }],
        },
        findings: [
          {
            type: 'V',
            data: 'http://x/?q=%3Csvg%3E',
            param: 'q',
            filter: { allowed: ['<', '>'], blocked: ['"'], escaped: ["'"] },
          },
        ],
      }),
    )
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ type: 'V', param: 'q' })
    expect(r.invalid).toBe(0)
  })

  it('returns an empty report (not a throw) for malformed JSON', () => {
    expect(parseDalfoxReport('not json').findings).toEqual([])
  })

  it('counts unparsable entries instead of dropping them silently', () => {
    const r = parseDalfoxReport(
      JSON.stringify({ findings: [{ type: 'V', data: 'http://x/', param: 'q' }, 42, 'x'] }),
    )
    expect(r.findings).toHaveLength(1)
    expect(r.invalid).toBe(2)
  })
})

describe('dalfoxSeverity', () => {
  it('promotes only verified (V) findings to high', () => {
    expect(dalfoxSeverity('V')).toBe('high')
  })
  it('ranks by verification confidence: AST (A) is medium, reflection-only (R) is low', () => {
    expect(dalfoxSeverity('A')).toBe('medium')
    expect(dalfoxSeverity('R')).toBe('low')
  })
})

describe('normalizeDalfoxFindings', () => {
  it('details V as high, counts reflection-only (R) as low without detailing it, drops I', () => {
    const { findings, counts } = normalizeDalfoxFindings(
      parseDalfoxReport(fixture).findings,
      identity,
    )
    // 3 in the fixture: one V, one R, one I. I is not an XSS tier (never
    // counted); R is a reflection-only signal — counted as low but below the
    // reported floor, so only the verified V is emitted as a detailed finding.
    expect(findings).toHaveLength(1)
    expect(findings.map((f) => f.severity)).toEqual(['high'])
    expect(counts.high).toBe(1)
    expect(counts.medium).toBe(0)
    // R is still visible in the counts, not silently suppressed.
    expect(counts.low).toBe(1)
  })

  it('gives every finding a stable, non-payload-derived ruleId keyed on the detection method', () => {
    const { findings } = normalizeDalfoxFindings(parseDalfoxReport(fixture).findings, identity)
    const verified = findings.find((f) => f.severity === 'high')!
    expect(verified.ruleId).toBe('dalfox:reflection')
    expect(verified.engine).toBe('dalfox')
    expect(verified.param).toBe('q')
    // The reported url is dalfox's poc URL (payload in the query); the
    // fingerprint drops the query, so identity stays stable regardless.
    expect(verified.url).toContain('/rest/products/search')
  })

  it('normalizes an AST DOM finding: `-` param becomes null, ruleId is dalfox:ast', () => {
    const { findings } = normalizeDalfoxFindings(
      [
        {
          type: 'A',
          inject_type: 'DOM-XSS',
          method: 'GET',
          data: 'http://localhost:3001/#/search?q=x',
          param: '-',
          payload: 'alert(1)',
          evidence: 'AST finding',
          cwe: 'CWE-79',
          severity: 'Medium',
          message_str: 'AST DOM XSS',
          detection_method: 'ast',
        },
      ],
      identity,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.param).toBeNull()
    expect(findings[0]!.ruleId).toBe('dalfox:ast')
    expect(findings[0]!.severity).toBe('medium')
  })

  it('un-aliases the reported URL via the supplied restorer', () => {
    const { findings } = normalizeDalfoxFindings(
      [
        {
          type: 'V',
          data: 'http://host.docker.internal:3001/rest/x?q=1',
          param: 'q',
          cwe: 'CWE-79',
        },
      ],
      (u) => u.replace('host.docker.internal', 'localhost'),
    )
    expect(findings[0]!.url).toContain('localhost')
  })
})

describe('dalfoxReachability', () => {
  it('flags all-unreachable when every target failed to connect', () => {
    const r = dalfoxReachability({
      target_summary: [
        { status: 'skipped', error_code: 'CONNECTION_FAILED' },
        { status: 'skipped', error_code: 'CONNECTION_FAILED' },
      ],
    })
    expect(r.total).toBe(2)
    expect(r.unreachable).toBe(2)
    expect(r.allUnreachable).toBe(true)
  })

  it('is not all-unreachable when at least one target was reached', () => {
    const r = dalfoxReachability({
      target_summary: [
        { status: 'findings' },
        { status: 'skipped', error_code: 'CONNECTION_FAILED' },
      ],
    })
    expect(r.allUnreachable).toBe(false)
    expect(r.unreachable).toBe(1)
  })

  it('does not count a bare skipped target (no error_code) as unreachable', () => {
    const r = dalfoxReachability({
      target_summary: [
        { status: 'skipped' },
        { status: 'skipped', error_code: 'CONNECTION_FAILED' },
      ],
    })
    // Only the one with an error_code counts; not all-unreachable, so a real
    // exit-2 error would still surface rather than being masked.
    expect(r.unreachable).toBe(1)
    expect(r.allUnreachable).toBe(false)
  })

  it('is empty/false when there is no target_summary', () => {
    expect(dalfoxReachability({})).toEqual({ total: 0, unreachable: 0, allUnreachable: false })
  })
})
