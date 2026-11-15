import { describe, expect, it } from 'vitest'
import { buildKatanaArgs } from '../args'

describe('buildKatanaArgs', () => {
  it('builds a static, fqdn-scoped, JSONL crawl bounded by the minute budget', () => {
    const args = buildKatanaArgs({
      seedsFile: '/w/seeds.txt',
      outputFile: '/w/urls.jsonl',
      maxMinutes: 5,
      headersConfigFile: null,
    })
    expect(args).toEqual([
      '-list',
      '/w/seeds.txt',
      '-jc',
      '-kf',
      'all',
      '-d',
      '3',
      '-fs',
      'fqdn',
      '-ct',
      '5m',
      '-jsonl',
      '-o',
      '/w/urls.jsonl',
      '-silent',
      '-nc',
      '-duc',
      '-eof',
      'raw,body,headers',
    ])
    // Static mode only — never the headless browser.
    expect(args).not.toContain('-headless')
    expect(args).not.toContain('-hl')
    // -omit-body silently disables JS-bundle parsing in katana 1.7.0.
    expect(args).not.toContain('-omit-body')
    expect(args).not.toContain('-ob')
  })

  it('adds one -cs pair per crawl-scope regex right after the host scope, none when unrestricted', () => {
    const base = { seedsFile: 's', outputFile: 'o', maxMinutes: 1, headersConfigFile: null }
    const scoped = buildKatanaArgs({
      ...base,
      crawlScopeRegexes: ['^http://h:3000/rest(/.*)?(\\?.*)?$', '^http://h:3000/$'],
    })
    expect(scoped.slice(7, 13)).toEqual([
      '-fs',
      'fqdn',
      '-cs',
      '^http://h:3000/rest(/.*)?(\\?.*)?$',
      '-cs',
      '^http://h:3000/$',
    ])
    expect(buildKatanaArgs({ ...base, crawlScopeRegexes: [] })).toEqual(buildKatanaArgs(base))
    expect(buildKatanaArgs(base)).not.toContain('-cs')
  })

  it('adds -aff (automatic form fill) only when active form fill is on; argv unchanged otherwise', () => {
    const base = { seedsFile: 's', outputFile: 'o', maxMinutes: 1, headersConfigFile: null }
    const active = buildKatanaArgs({ ...base, activeFormFill: true })
    expect(active).toContain('-aff')
    // -aff sits just before -ct (after the scope block)
    expect(active[active.indexOf('-aff') + 1]).toBe('-ct')
    expect(buildKatanaArgs({ ...base, activeFormFill: false })).not.toContain('-aff')
    expect(buildKatanaArgs(base)).not.toContain('-aff')
    expect(buildKatanaArgs({ ...base, activeFormFill: false })).toEqual(buildKatanaArgs(base))
  })

  it('passes the headers config file with -config, never a -H value (#95)', () => {
    const args = buildKatanaArgs({
      seedsFile: 's',
      outputFile: 'o',
      maxMinutes: 1,
      headersConfigFile: '/w/katana/headers.json',
    })
    expect(args.slice(-2)).toEqual(['-config', '/w/katana/headers.json'])
    expect(args).not.toContain('-H')
  })
})
