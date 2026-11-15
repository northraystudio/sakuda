import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EngineError } from '../../types'
import { normalizeZapReport, parseZapReport, stripHtml, zapRiskToLevel } from '../report'
import type { SeverityLevel } from '#shared/types/api'

const fixturePath = fileURLToPath(new URL('./fixtures/zap-report.json', import.meta.url))
const fixtureText = readFileSync(fixturePath, 'utf-8')
const unalias = (u: string) => u.replace('host.docker.internal', 'localhost')

describe('parseZapReport', () => {
  it('parses a valid ZAP traditional-json report', () => {
    const report = parseZapReport(fixtureText)
    expect(report['@version']).toBe('2.17.0')
    expect(report.site).toHaveLength(1)
  })

  it('throws EngineError on invalid JSON', () => {
    expect(() => parseZapReport('{not json')).toThrow(EngineError)
  })

  it('throws EngineError when the "site" array is missing', () => {
    expect(() => parseZapReport(JSON.stringify({ '@version': '2.17.0' }))).toThrow(EngineError)
  })
})

describe('zapRiskToLevel', () => {
  it('maps ZAP riskcode strings to severity levels', () => {
    expect(zapRiskToLevel('3')).toBe('high')
    expect(zapRiskToLevel('2')).toBe('medium')
    expect(zapRiskToLevel('1')).toBe('low')
    expect(zapRiskToLevel('0')).toBe('info')
    expect(zapRiskToLevel(undefined)).toBe('info')
  })
})

describe('stripHtml', () => {
  it('strips tags, joins paragraphs with a newline, and unescapes entities', () => {
    expect(stripHtml('<p>a &amp; b</p><p>c &lt;d&gt; &quot;e&quot;</p>')).toBe('a & b\nc <d> "e"')
  })

  it('returns an empty string for undefined', () => {
    expect(stripHtml(undefined)).toBe('')
  })
})

describe('normalizeZapReport', () => {
  const report = parseZapReport(fixtureText)
  const result = normalizeZapReport(report, 'zap-fe', unalias)

  it('produces one finding per reported-severity instance (2 high + 1 medium)', () => {
    expect(result.findings).toHaveLength(3)
  })

  it('counts instances by severity across all instances (including info)', () => {
    expect(result.counts).toEqual({ critical: 0, high: 2, medium: 1, low: 0, info: 1 })
  })

  it('counts one per alert regardless of instance count', () => {
    expect(result.alertCounts).toEqual({ critical: 0, high: 1, medium: 1, low: 0, info: 1 })
  })

  it('collects sorted, unique, un-aliased reached URLs', () => {
    expect(result.reachedUrls).toEqual([...result.reachedUrls].sort())
    expect(new Set(result.reachedUrls).size).toBe(result.reachedUrls.length)
    for (const u of result.reachedUrls) expect(u).not.toContain('host.docker.internal')
  })

  it('counts the 401/403 auth-failure instance', () => {
    expect(result.authFailureCount).toBe(1)
  })

  it('reports the ZAP version from the report', () => {
    expect(result.zapVersion).toBe('2.17.0')
  })

  it('reports the total alert count (3, regardless of severity filtering)', () => {
    expect(result.totalAlerts).toBe(3)
  })

  it('builds finding fields from the alert/instance', () => {
    const high = result.findings.find((f) => f.severity === 'high')!
    expect(high.ruleId).toBe('40018-1')
    expect(high.name).toBe('SQL Injection')
    expect(high.url).toBe('http://localhost:3000/company/login?query=1')
    expect(high.method).toBe('GET')
    expect(high.param).toBe('query')
    expect(high.evidence).toBe('SQL syntax error')
    expect(high.description).toBe('SQL injection may be possible.')
    expect(high.solution).toContain('Do not trust client side input')
    expect(high.reference).toContain('owasp.org')
    expect(high.raw).toEqual({
      pluginid: '40018',
      cweid: '89',
      confidence: '2',
      riskdesc: 'High (Medium)',
      attack: "1' OR '1'='1",
      otherinfo: 'Injectable parameter: query',
    })
  })

  it('builds the medium finding from the auth-failure instance (empty param, 401 evidence)', () => {
    const medium = result.findings.find((f) => f.severity === 'medium')!
    expect(medium.severity).toBe('medium')
    expect(medium.param).toBeNull()
    expect(medium.evidence).toBe('401 Unauthorized')
  })

  it('does not emit a finding for the info-level alert (not a reported severity)', () => {
    // NewFinding.severity is typed to the reported levels only; read it as the
    // wider SeverityLevel so this stays a runtime check of normalize's filter.
    const levelOf = (f: { severity: SeverityLevel }): SeverityLevel => f.severity
    expect(result.findings.some((f) => levelOf(f) === 'info')).toBe(false)
  })
})
