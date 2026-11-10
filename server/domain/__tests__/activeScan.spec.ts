import { describe, expect, it } from 'vitest'
import {
  countParameterizedUrls,
  effectiveRiskTags,
  FUZZ_SEED_VALUE,
  isActiveScanEnabled,
  isSafeMethod,
  riskExcludeTags,
  riskExtraTags,
  SAFE_METHODS,
  seedEmptyQueryValues,
} from '../activeScan'
import type { RiskTag } from '#shared/types/api'

describe('isSafeMethod / SAFE_METHODS', () => {
  it('treats read-only verbs as safe and mutating verbs as not', () => {
    expect(SAFE_METHODS).toEqual(['GET', 'HEAD', 'OPTIONS'])
    for (const m of ['GET', 'HEAD', 'OPTIONS'] as const) expect(isSafeMethod(m)).toBe(true)
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) expect(isSafeMethod(m)).toBe(false)
  })
})

describe('isActiveScanEnabled', () => {
  it('is off by default (no opt-in) even for a local site', () => {
    expect(
      isActiveScanEnabled({
        allowMutatingRequests: false,
        requiresConfirmation: false,
        nonLocalConfirmed: false,
        nucleiEnabledRiskTags: [],
        nucleiTags: [],
        openapiAllowedOrigins: [],
      }),
    ).toBe(false)
  })

  it('is on when opted in and the host is local (no confirmation needed)', () => {
    expect(
      isActiveScanEnabled({
        allowMutatingRequests: true,
        requiresConfirmation: false,
        nonLocalConfirmed: false,
        nucleiEnabledRiskTags: [],
        nucleiTags: [],
        openapiAllowedOrigins: [],
      }),
    ).toBe(true)
  })

  it('is on when opted in and a non-local host has been confirmed', () => {
    expect(
      isActiveScanEnabled({
        allowMutatingRequests: true,
        requiresConfirmation: true,
        nonLocalConfirmed: true,
        nucleiEnabledRiskTags: [],
        nucleiTags: [],
        openapiAllowedOrigins: [],
      }),
    ).toBe(true)
  })

  it('stays off when opted in but ownership of a non-local host is not confirmed', () => {
    expect(
      isActiveScanEnabled({
        allowMutatingRequests: true,
        requiresConfirmation: true,
        nonLocalConfirmed: false,
        nucleiEnabledRiskTags: [],
        nucleiTags: [],
        openapiAllowedOrigins: [],
      }),
    ).toBe(false)
  })
})

describe('countParameterizedUrls', () => {
  it('counts only URLs with a non-empty query string', () => {
    expect(
      countParameterizedUrls([
        'http://localhost:3001/',
        'http://localhost:3001/rest/products/search?q=',
        'http://localhost:3001/api/users?page=1&size=10',
        'http://localhost:3001/bare?',
        'not a url',
      ]),
    ).toBe(2)
  })

  it('returns 0 for an empty list', () => {
    expect(countParameterizedUrls([])).toBe(0)
  })
})

describe('seedEmptyQueryValues', () => {
  it('fills an empty query value with the fuzz seed so nuclei has something to mutate', () => {
    expect(seedEmptyQueryValues(['http://localhost:3001/rest/products/search?q='])).toEqual([
      `http://localhost:3001/rest/products/search?q=${FUZZ_SEED_VALUE}`,
    ])
  })

  it('leaves a parameter that already has a value untouched', () => {
    expect(seedEmptyQueryValues(['http://localhost:3001/search?q=apple'])).toEqual([
      'http://localhost:3001/search?q=apple',
    ])
  })

  it('fills only the empty parameters in a mixed query', () => {
    expect(seedEmptyQueryValues(['http://localhost:3001/x?a=&b=2&c='])).toEqual([
      `http://localhost:3001/x?a=${FUZZ_SEED_VALUE}&b=2&c=${FUZZ_SEED_VALUE}`,
    ])
  })

  it('leaves a URL with no query string untouched', () => {
    expect(seedEmptyQueryValues(['http://localhost:3001/plain'])).toEqual([
      'http://localhost:3001/plain',
    ])
  })

  it('returns an unparsable entry unchanged rather than dropping it', () => {
    expect(seedEmptyQueryValues(['not a url'])).toEqual(['not a url'])
  })
})

describe('effectiveRiskTags', () => {
  const on = (nucleiEnabledRiskTags: RiskTag[]) => ({
    allowMutatingRequests: true,
    requiresConfirmation: false,
    nonLocalConfirmed: false,
    nucleiEnabledRiskTags,
  })

  it('returns the selected tags in canonical order when active checks are on', () => {
    expect(effectiveRiskTags(on(['fuzz', 'intrusive']))).toEqual(['fuzz', 'intrusive'])
    // input order does not matter; RISK_TAGS order (dos, fuzz, intrusive) wins
    expect(effectiveRiskTags(on(['intrusive', 'dos']))).toEqual(['dos', 'intrusive'])
  })

  it('is empty when the opt-in is off, even if tags are selected (stale snapshot cannot re-open)', () => {
    expect(
      effectiveRiskTags({
        allowMutatingRequests: false,
        requiresConfirmation: false,
        nonLocalConfirmed: false,
        nucleiEnabledRiskTags: ['fuzz', 'dos', 'intrusive'],
      }),
    ).toEqual([])
  })

  it('is empty when a non-local host is not confirmed', () => {
    expect(
      effectiveRiskTags({
        allowMutatingRequests: true,
        requiresConfirmation: true,
        nonLocalConfirmed: false,
        nucleiEnabledRiskTags: ['fuzz'],
      }),
    ).toEqual([])
  })
})

describe('riskExcludeTags', () => {
  it('excludes all three risk tags when nothing is enabled (the default)', () => {
    expect(riskExcludeTags([])).toEqual(['dos', 'fuzz', 'intrusive'])
  })

  it('drops only the enabled tags from the exclusion', () => {
    expect(riskExcludeTags(['fuzz'])).toEqual(['dos', 'intrusive'])
    expect(riskExcludeTags(['dos', 'fuzz', 'intrusive'])).toEqual([])
  })
})

describe('riskExtraTags', () => {
  it('adds nothing for intrusive (its CVE templates already match the base allow-list)', () => {
    expect(riskExtraTags(['intrusive'])).toEqual([])
  })

  it('adds cmdi,rce for fuzz so command-injection/RCE templates actually load', () => {
    expect(riskExtraTags(['fuzz'])).toEqual(['cmdi', 'rce'])
  })

  it('adds dos for dos, and dedupes across groups', () => {
    expect(riskExtraTags(['dos', 'fuzz', 'intrusive'])).toEqual(['dos', 'cmdi', 'rce'])
  })

  it('adds nothing when no group is enabled', () => {
    expect(riskExtraTags([])).toEqual([])
  })
})
