import { describe, expect, it } from 'vitest'
import {
  buildNucleiArgs,
  buildNucleiDastArgs,
  buildNucleiOpenapiArgs,
  fullSignatureExcludeTags,
  NUCLEI_BASE_TAGS,
  NUCLEI_PRIORITY_SIGNATURE_TAGS,
  nucleiTagsFor,
} from '../args'
import type { OastConfig } from '../../../config/env'

const PUBLIC: OastConfig = { mode: 'public' }

describe('fullSignatureExcludeTags (#3)', () => {
  it('adds the priority tags to the risk excludes so the two passes never overlap', () => {
    expect(fullSignatureExcludeTags(['dos', 'fuzz', 'intrusive'])).toEqual([
      'dos',
      'fuzz',
      'intrusive',
      ...NUCLEI_PRIORITY_SIGNATURE_TAGS,
    ])
  })
  it('de-duplicates when a risk exclude already names a priority tag', () => {
    expect(fullSignatureExcludeTags(['dos', 'exposure'])).toEqual([
      'dos',
      'exposure',
      'config',
      'misconfig',
    ])
  })
})

describe('nucleiTagsFor', () => {
  it('returns the base tags when unauthenticated', () => {
    expect(nucleiTagsFor(false)).toEqual(NUCLEI_BASE_TAGS)
  })

  it('appends auth-bypass when authenticated', () => {
    expect(nucleiTagsFor(true)).toEqual([...NUCLEI_BASE_TAGS, 'auth-bypass'])
  })
})

describe('buildNucleiArgs', () => {
  it('builds the exact argument array', () => {
    expect(
      buildNucleiArgs({
        targetsFile: 't.txt',
        templatesDir: '/tpl',
        outputFile: 'o.jsonl',
        rateLimit: 50,
        concurrency: 25,
        tags: ['xss', 'sqli'],
        headersConfigFile: '/w/headers.json',
        oast: PUBLIC,
      }),
    ).toEqual([
      '-l',
      't.txt',
      '-t',
      '/tpl',
      '-tags',
      'xss,sqli',
      '-severity',
      'critical,high,medium',
      '-exclude-tags',
      'dos,fuzz,intrusive',
      '-rate-limit',
      '50',
      '-c',
      '25',
      '-jsonl',
      '-o',
      'o.jsonl',
      '-stats-json',
      '-si',
      '5',
      '-duc',
      '-no-mhe',
      '-nc',
      '-omit-raw',
      '-config',
      '/w/headers.json',
    ])
  })

  it('always includes -omit-raw so request/response pairs (which may contain injected auth headers) are never written to disk', () => {
    expect(
      buildNucleiArgs({
        targetsFile: 't.txt',
        templatesDir: '/tpl',
        outputFile: 'o.jsonl',
        rateLimit: 50,
        concurrency: 25,
        tags: ['xss'],
        headersConfigFile: null,
        oast: PUBLIC,
        browserStorage: [],
      }),
    ).toContain('-omit-raw')
  })
})

describe('buildNucleiDastArgs (the active GET DAST phase)', () => {
  const base = {
    targetsFile: 't.txt',
    dastTemplatesDir: '/tpl/dast',
    outputFile: 'dast.jsonl',
    rateLimit: 50,
    concurrency: 25,
    tags: ['sqli', 'cmdi'],
    excludeTags: ['dos', 'intrusive'],
    headersConfigFile: '/w/headers.json',
    oast: PUBLIC,
  }

  it('loads only the DAST tree with -dast and the same tag filters as the signature phase', () => {
    expect(buildNucleiDastArgs(base)).toEqual([
      '-l',
      't.txt',
      '-t',
      '/tpl/dast',
      '-dast',
      '-tags',
      'sqli,cmdi',
      '-severity',
      'critical,high,medium',
      '-exclude-tags',
      'dos,intrusive',
      '-rate-limit',
      '50',
      '-c',
      '25',
      '-jsonl',
      '-o',
      'dast.jsonl',
      '-stats-json',
      '-si',
      '5',
      '-duc',
      '-no-mhe',
      '-nc',
      '-omit-raw',
      '-config',
      '/w/headers.json',
    ])
  })

  it('never loads the signature tree: -dast would silence it (nuclei runs DAST templates only)', () => {
    const args = buildNucleiDastArgs(base)
    expect(args.filter((a) => a === '-t')).toHaveLength(1)
    expect(args).not.toContain('/tpl/http')
  })
})

describe('buildNucleiArgs is the signature phase in both modes', () => {
  it('never passes -dast, which would drop every signature template', () => {
    const args = buildNucleiArgs({
      targetsFile: 't.txt',
      templatesDir: '/tpl/http',
      outputFile: 'o.jsonl',
      rateLimit: 50,
      concurrency: 25,
      tags: ['sqli', 'cmdi'],
      excludeTags: ['dos'],
      headersConfigFile: null,
      oast: PUBLIC,
    })
    expect(args).not.toContain('-dast')
    expect(args.filter((a) => a === '-t')).toHaveLength(1)
    expect(args.slice(args.indexOf('-exclude-tags'), args.indexOf('-exclude-tags') + 2)).toEqual([
      '-exclude-tags',
      'dos',
    ])
  })
})

describe('buildNucleiOpenapiArgs', () => {
  const base = {
    openapiFile: '/w/openapi-0.json',
    dastTemplatesDir: '/tpl/dast',
    outputFile: '/w/openapi-findings-0.jsonl',
    rateLimit: 50,
    concurrency: 25,
    headersConfigFile: '/w/headers.json',
    oast: PUBLIC,
  }

  it('imports the OpenAPI doc, loads only the DAST tree, no tag filter, -omit-raw kept', () => {
    const args = buildNucleiOpenapiArgs(base)
    expect(args.slice(0, 7)).toEqual([
      '-l',
      '/w/openapi-0.json',
      '-im',
      'openapi',
      '-t',
      '/tpl/dast',
      '-dast',
    ])
    // exactly one -t (the DAST tree), no signature http tree, no -tags/-exclude-tags
    expect(args.filter((a) => a === '-t')).toHaveLength(1)
    expect(args).not.toContain('-tags')
    expect(args).not.toContain('-exclude-tags')
    expect(args).toContain('-omit-raw')
    expect(args.slice(-2)).toEqual(['-config', '/w/headers.json'])
    expect(args.slice(args.indexOf('-severity'), args.indexOf('-severity') + 2)).toEqual([
      '-severity',
      'critical,high,medium',
    ])
  })
})

describe('buildNucleiArgs excludeTags', () => {
  const base = {
    targetsFile: 't.txt',
    templatesDir: '/tpl',
    outputFile: 'o.jsonl',
    rateLimit: 50,
    concurrency: 25,
    tags: ['sqli'],
    headersConfigFile: null,
    oast: PUBLIC,
  }
  const excludeOf = (args: string[]) => args[args.indexOf('-exclude-tags') + 1]

  it('defaults -exclude-tags to all three risk tags when none is passed', () => {
    expect(excludeOf(buildNucleiArgs(base))).toBe('dos,fuzz,intrusive')
  })

  it('joins the provided excludeTags list (a risk group opted back in)', () => {
    expect(excludeOf(buildNucleiArgs({ ...base, excludeTags: ['dos', 'intrusive'] }))).toBe(
      'dos,intrusive',
    )
  })

  it('emits an empty -exclude-tags value when every risk group is enabled', () => {
    expect(excludeOf(buildNucleiArgs({ ...base, excludeTags: [] }))).toBe('')
  })
})

describe('host-error guard (#82)', () => {
  const headersConfigFile = '/w/headers.json'

  it('every phase passes -no-mhe: one skipped host would silently end the phase', () => {
    const signature = buildNucleiArgs({
      targetsFile: 't.txt',
      templatesDir: '/tpl/http',
      outputFile: 'o.jsonl',
      rateLimit: 50,
      concurrency: 25,
      tags: ['sqli'],
      headersConfigFile,
      oast: PUBLIC,
    })
    const dast = buildNucleiDastArgs({
      targetsFile: 't.txt',
      dastTemplatesDir: '/tpl/dast',
      outputFile: 'dast.jsonl',
      rateLimit: 50,
      concurrency: 25,
      tags: ['sqli'],
      excludeTags: ['dos'],
      headersConfigFile,
      oast: PUBLIC,
    })
    const openapi = buildNucleiOpenapiArgs({
      openapiFile: '/w/openapi-0.json',
      dastTemplatesDir: '/tpl/dast',
      outputFile: 'oa.jsonl',
      rateLimit: 50,
      concurrency: 25,
      headersConfigFile,
      oast: PUBLIC,
    })
    for (const args of [signature, dast, openapi]) {
      expect(args).toContain('-no-mhe')
      expect(args).not.toContain('-mhe')
      expect(args).not.toContain('-max-host-error')
    }
  })
})

describe('headers never on argv (#95)', () => {
  it('passes -config <file> in every phase and nothing header-related without a file', () => {
    const withFile = { headersConfigFile: '/w/headers.json' }
    const without = { headersConfigFile: null }
    const signature = (h: typeof withFile) =>
      buildNucleiArgs({
        targetsFile: 't',
        templatesDir: '/tpl',
        outputFile: 'o',
        rateLimit: 1,
        concurrency: 1,
        tags: [],
        oast: PUBLIC,
        ...h,
      })
    const dast = (h: typeof withFile) =>
      buildNucleiDastArgs({
        targetsFile: 't',
        dastTemplatesDir: '/d',
        outputFile: 'o',
        rateLimit: 1,
        concurrency: 1,
        tags: [],
        excludeTags: [],
        oast: PUBLIC,
        ...h,
      })
    const openapi = (h: typeof withFile) =>
      buildNucleiOpenapiArgs({
        openapiFile: 'oa',
        dastTemplatesDir: '/d',
        outputFile: 'o',
        rateLimit: 1,
        concurrency: 1,
        oast: PUBLIC,
        ...h,
      })
    for (const build of [signature, dast, openapi]) {
      expect(build(withFile).slice(-2)).toEqual(['-config', '/w/headers.json'])
      expect(build(withFile)).not.toContain('-H')
      expect(build(without)).not.toContain('-config')
      expect(build(without)).not.toContain('-H')
    }
  })
})

describe('OAST setting reaches every phase (#35)', () => {
  const build = (oast: OastConfig) => [
    buildNucleiArgs({
      targetsFile: 't',
      templatesDir: '/tpl',
      outputFile: 'o',
      rateLimit: 1,
      concurrency: 1,
      tags: [],
      headersConfigFile: null,
      oast,
    }),
    buildNucleiDastArgs({
      targetsFile: 't',
      dastTemplatesDir: '/d',
      outputFile: 'o',
      rateLimit: 1,
      concurrency: 1,
      tags: [],
      excludeTags: [],
      headersConfigFile: null,
      oast,
    }),
    buildNucleiOpenapiArgs({
      openapiFile: 'oa',
      dastTemplatesDir: '/d',
      outputFile: 'o',
      rateLimit: 1,
      concurrency: 1,
      headersConfigFile: null,
      oast,
    }),
  ]

  it('off: every phase passes -ni, so no interactsh traffic leaves the scan', () => {
    for (const args of build({ mode: 'off' })) expect(args).toContain('-ni')
  })

  it('self-hosted: every phase passes -iserver, and the token is never on argv', () => {
    for (const args of build({
      mode: 'self-hosted',
      serverUrl: 'https://oast.example.test',
      token: 'tok-secret',
    })) {
      expect(args.slice(-2)).toEqual(['-iserver', 'https://oast.example.test'])
      expect(args.join(' ')).not.toContain('tok-secret')
      expect(args).not.toContain('-itoken')
    }
  })

  it('public: no interactsh flag at all (nuclei default servers)', () => {
    for (const args of build({ mode: 'public' })) {
      expect(args).not.toContain('-ni')
      expect(args).not.toContain('-iserver')
    }
  })
})
