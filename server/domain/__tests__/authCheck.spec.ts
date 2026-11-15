import { describe, expect, it } from 'vitest'
import {
  classifyAuthStatus,
  detectAuthCheckHint,
  isLoginRejected,
  resolveAuthCheckUrl,
} from '../authCheck'

const site = {
  frontBaseUrl: 'http://localhost:3000',
  apiBaseUrl: 'http://localhost:3001/v1',
  authCheckPath: null as string | null,
}

describe('resolveAuthCheckUrl', () => {
  it('is null when the site has no check path', () => {
    expect(resolveAuthCheckUrl(site)).toBeNull()
  })

  it('joins a plain path onto the front base URL', () => {
    expect(resolveAuthCheckUrl({ ...site, authCheckPath: '/account' })).toBe(
      'http://localhost:3000/account',
    )
  })

  it('joins an api: path onto the API base URL', () => {
    expect(resolveAuthCheckUrl({ ...site, authCheckPath: 'api:/me' })).toBe(
      'http://localhost:3001/v1/me',
    )
  })

  it('is null for an api: path when the site has no API base URL', () => {
    expect(resolveAuthCheckUrl({ ...site, apiBaseUrl: null, authCheckPath: 'api:/me' })).toBeNull()
  })

  it('never leaves the site origin, even for a path that looks like another host', () => {
    const url = resolveAuthCheckUrl({ ...site, authCheckPath: '//evil.example/x' })
    expect(new URL(url ?? '').origin).toBe('http://localhost:3000')
  })
})

describe('isLoginRejected', () => {
  it.each([401, 403])('treats %i as a lost login', (status) => {
    expect(isLoginRejected(status)).toBe(true)
  })

  it.each([200, 204, 302, 404, 500])('does not treat %i as a lost login', (status) => {
    expect(isLoginRejected(status)).toBe(false)
  })
})

describe('classifyAuthStatus', () => {
  it.each([
    [200, 'ok'],
    [204, 'ok'],
    [401, 'rejected'],
    [403, 'rejected'],
    [301, 'redirect'],
    [302, 'redirect'],
    [404, 'unexpected'],
    [500, 'unexpected'],
  ] as const)('reads %i as %s', (status, outcome) => {
    expect(classifyAuthStatus(status)).toBe(outcome)
  })
})

describe('detectAuthCheckHint', () => {
  const viteBlock =
    'Blocked request. This host ("host.docker.internal") is not allowed.\n' +
    'To allow this host, add "host.docker.internal" to `server.allowedHosts` in vite.config.js.'

  it.each([401, 403])('flags the Vite allowedHosts block page on %i', (status) => {
    expect(detectAuthCheckHint({ status, bodyHead: viteBlock })).toBe('blocked-before-app')
  })

  it.each([
    ['JSON', '{"error":"unauthorized"}'],
    ['HTML', '<!doctype html><html><body><h1>403 Forbidden</h1></body></html>'],
    ['plain text', 'Forbidden'],
    ['an empty body', ''],
    ['the phrase quoted mid-body', '{"error":"forbidden","detail":"Blocked request. This host"}'],
  ])("leaves the target's own 403 with %s alone", (_kind, bodyHead) => {
    expect(detectAuthCheckHint({ status: 403, bodyHead })).toBeNull()
  })

  it('reads the opening after leading whitespace', () => {
    expect(detectAuthCheckHint({ status: 403, bodyHead: `\n  ${viteBlock}` })).toBe(
      'blocked-before-app',
    )
  })

  it('is null when the body could not be read', () => {
    expect(
      detectAuthCheckHint({ status: 403, bodyHead: null, bodyReadError: 'aborted' }),
    ).toBeNull()
  })

  it.each([200, 302, 404, 500])('never flags a %i, whatever the body', (status) => {
    expect(detectAuthCheckHint({ status, bodyHead: viteBlock })).toBeNull()
  })
})
