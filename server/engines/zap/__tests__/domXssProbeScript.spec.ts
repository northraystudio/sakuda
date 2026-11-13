import { describe, expect, it } from 'vitest'
import {
  buildDomXssProbeScript,
  parseDomXssProbeSummary,
  DOM_XSS_PROBE_PAYLOADS,
} from '../domXssProbeScript'

describe('buildDomXssProbeScript', () => {
  const script = buildDomXssProbeScript({
    routes: ['http://host.docker.internal:3000/#/search?q='],
    origin: 'http://host.docker.internal:3000',
    outputPath: '/zap/wrk/dom-xss-probe.json',
    budgetMs: 1_000_000,
    settleMs: 800,
  })

  it('embeds routes, payloads and config as JSON literals (no source splicing)', () => {
    expect(script).toContain('var ROUTES = ["http://host.docker.internal:3000/#/search?q="]')
    expect(script).toContain('var SETTLE_MS = 800')
    expect(script).toContain('var BUDGET_MS = 1000000')
    expect(script).toContain('var OUTPUT = "/zap/wrk/dom-xss-probe.json"')
    for (const p of DOM_XSS_PROBE_PAYLOADS) expect(script).toContain(JSON.stringify(p))
  })

  it('detects via a DOM canary, never an alert() dialog', () => {
    expect(script).toContain('window[arguments[0]]')
    expect(script).not.toMatch(/alert\(/)
  })

  it('navigates through about:blank so a fragment-only change still reloads', () => {
    expect(script).toContain("wd.get('about:blank')")
    expect(script).toContain('wd.get(target)')
  })

  it('raises a HIGH ZAP alert with a HistoryReference so it lands in the report', () => {
    expect(script).toContain('Alert.RISK_HIGH')
    expect(script).toContain('extAlert.alertFound(alert, href)')
    expect(script).toContain('new HistoryReference(session, HistoryReference.TYPE_SCANNER, msg)')
  })

  it('opens the browser on the front origin right after launch', () => {
    expect(script).toContain('var ORIGIN = "http://host.docker.internal:3000"')
    expect(script).toContain('wd.get(ORIGIN)')
    expect(script.indexOf('extSel.getWebDriver(')).toBeLessThan(script.indexOf('wd.get(ORIGIN)'))
  })

  it('launches with Selenium scripts run synchronously, so the storage hook finishes first (#71)', () => {
    expect(script).toContain('.syncScriptExecution(true)')
    expect(script).not.toContain('extSel.getProxiedBrowser(')
  })

  it('launches the same browser as getProxiedBrowser did: proxied via ZAP, extensions on', () => {
    expect(script).toContain('extSel.getWebDriver(\n    BROWSER_ID,')
    expect(script).toContain('.requester(HttpSender.PROXY_INITIATOR)')
    expect(script).toContain('.proxyAddress(proxy.getAddress())')
    expect(script).toContain('.proxyPort(proxy.getPort())')
    expect(script).toContain('.enableExtensions(true)')
    expect(script).toContain('getMainProxyServerInfo()')
  })

  it('honours the wall-clock deadline and writes a summary file', () => {
    expect(script).toContain('Date.now() > DEADLINE')
    expect(script).toContain('truncated = true')
    expect(script).toContain('Files.write')
  })

  it('escapes a route containing a script-terminator without breaking the literal', () => {
    const s = buildDomXssProbeScript({
      routes: ['http://h/#/x?q=</script><b>'],
      origin: 'http://h',
      outputPath: '/o.json',
      budgetMs: 1,
      settleMs: 1,
    })
    // JSON.stringify escapes "/" is optional; the important part is the value
    // is a valid JS string literal, so the closing tag is inside quotes.
    expect(s).toContain(JSON.stringify(['http://h/#/x?q=</script><b>']))
  })
})

describe('parseDomXssProbeSummary', () => {
  it('parses a valid summary', () => {
    expect(parseDomXssProbeSummary('{"probed":6,"hits":1,"truncated":false}')).toEqual({
      probed: 6,
      hits: 1,
      truncated: false,
    })
  })

  it('returns null on invalid or non-conforming JSON', () => {
    expect(parseDomXssProbeSummary('not json')).toBeNull()
    expect(parseDomXssProbeSummary('{"probed":"x"}')).toBeNull()
  })
})
