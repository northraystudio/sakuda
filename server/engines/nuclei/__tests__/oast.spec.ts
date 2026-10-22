import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OastConfig } from '../../../config/env'
import {
  NUCLEI_PUBLIC_OAST_SERVERS,
  oastArgs,
  oastServerLabel,
  probeOastServer,
  withNucleiConfig,
} from '../oast'

const PUBLIC: OastConfig = { mode: 'public' }
const OFF: OastConfig = { mode: 'off' }
const SELF: OastConfig = {
  mode: 'self-hosted',
  serverUrl: 'https://oast.example.test',
  token: 'tok-secret',
}

describe('oastArgs (#35)', () => {
  it('public adds nothing (nuclei registers with its own default list)', () => {
    expect(oastArgs(PUBLIC)).toEqual([])
  })
  it('off passes -ni, which also excludes the OAST templates', () => {
    expect(oastArgs(OFF)).toEqual(['-ni'])
  })
  it('self-hosted passes -iserver but never the token', () => {
    const args = oastArgs(SELF)
    expect(args).toEqual(['-iserver', 'https://oast.example.test'])
    expect(args.join(' ')).not.toContain('tok-secret')
  })
})

describe('oastServerLabel', () => {
  it('names the servers traffic may go to, never the token', () => {
    expect(oastServerLabel(PUBLIC)).toBe(NUCLEI_PUBLIC_OAST_SERVERS.join(','))
    expect(oastServerLabel(OFF)).toBeNull()
    expect(oastServerLabel(SELF)).toBe('https://oast.example.test')
  })
})

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
}

describe('probeOastServer (#35)', () => {
  it('off sends nothing at all', async () => {
    const fetchImpl = okFetch()
    expect(await probeOastServer(OFF, { fetchImpl })).toEqual({ reachable: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('any HTTP answer counts as reachable (interactsh answers / with 404 or a banner)', async () => {
    const fetchImpl = okFetch()
    expect(await probeOastServer(SELF, { fetchImpl })).toEqual({ reachable: true })
    expect(fetchImpl).toHaveBeenCalledWith('https://oast.example.test/', expect.anything())
  })

  it('public is reachable when at least one default server answers', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://oast.live/') return new Response('', { status: 200 })
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    expect(await probeOastServer(PUBLIC, { fetchImpl })).toEqual({ reachable: true })
    expect(fetchImpl).toHaveBeenCalledTimes(NUCLEI_PUBLIC_OAST_SERVERS.length)
  })

  it('reports the cause when no server answers', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const r = await probeOastServer(SELF, { fetchImpl })
    expect(r.reachable).toBe(false)
    if (!r.reachable) expect(r.reason).toContain('ECONNREFUSED')
  })

  it('gives up after the timeout instead of hanging the scan', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as unknown as typeof fetch
    const r = await probeOastServer(SELF, { fetchImpl, timeoutMs: 20 })
    expect(r.reachable).toBe(false)
    if (!r.reachable) expect(r.reason).toMatch(/20 ms/)
  })
})

describe('withNucleiConfig (#35)', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'sakuda-oast-'))

  it('without a token, nuclei keeps the shared headers file (or none)', async () => {
    const d = dir()
    expect(await withNucleiConfig(join(d, 'n.json'), [], PUBLIC, null, async (f) => f)).toBeNull()
    expect(
      await withNucleiConfig(join(d, 'n.json'), [], SELF_NO_TOKEN, '/h.json', async (f) => f),
    ).toBe('/h.json')
    expect(existsSync(join(d, 'n.json'))).toBe(false)
  })

  it('with a token, writes a 0600 nuclei-only config with headers + token, removed afterwards', async () => {
    const d = dir()
    const path = join(d, 'nuclei-config.json')
    let seen: unknown
    await withNucleiConfig(
      path,
      [{ name: 'Cookie', value: 'sid=1' }],
      SELF,
      '/h.json',
      async (f) => {
        expect(f).toBe(path)
        expect(statSync(path).mode & 0o777).toBe(0o600)
        seen = JSON.parse(readFileSync(path, 'utf8'))
      },
    )
    expect(seen).toEqual({ header: ['Cookie: sid=1'], 'interactsh-token': 'tok-secret' })
    expect(existsSync(path)).toBe(false)
  })

  it('removes the token file even when the run throws', async () => {
    const d = dir()
    const path = join(d, 'nuclei-config.json')
    await expect(
      withNucleiConfig(path, [], SELF, null, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(path)).toBe(false)
  })
})

const SELF_NO_TOKEN: OastConfig = {
  mode: 'self-hosted',
  serverUrl: 'https://oast.example.test',
  token: undefined,
}
