import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { allowedHostsWarnings, EnvError, parseEnv, retiredEnvWarnings } from '../env'
const key = randomBytes(32).toString('base64')
describe('parseEnv', () => {
  it('fails fast without SAKUDA_ENCRYPTION_KEY', () => {
    expect(() => parseEnv({})).toThrow(EnvError)
    expect(() => parseEnv({})).toThrow(/SAKUDA_ENCRYPTION_KEY/)
  })
  it('rejects a key that is not 32 bytes', () => {
    expect(() => parseEnv({ SAKUDA_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(
      /32 bytes/,
    )
  })
  it('applies defaults and derives paths', () => {
    const env = parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_DATA_DIR: '/tmp/x' })
    expect(env.dbFile).toBe('/tmp/x/sakuda.db')
    expect(env.scansDir).toBe('/tmp/x/scans')
    expect(env.nuclei.maxMinutes).toBe(60)
    expect(env.nuclei.concurrency).toBe(25)
    expect(env.nuclei.templatesDir).toBe('/opt/nuclei-templates/http')
    expect(env.nuclei.dastTemplatesDir).toBe('/opt/nuclei-templates/dast')
    expect(env.katana.bin).toBe('katana')
    expect(env.httpx).toEqual({ bin: 'httpx', maxMinutes: 5, pruneStatusCodes: [] })
    expect(env.zap.cmd).toBe('zap.sh')
    expect(env.jobRunner).toBe(true)
  })
  it('zap alias falls back to the general alias', () => {
    expect(
      parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_LOCALHOST_ALIAS: 'host.docker.internal' }).zap
        .localhostAlias,
    ).toBe('host.docker.internal')
    const env2 = parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_ZAP_LOCALHOST_ALIAS: 'gw' })
    expect(env2.localhostAlias).toBeUndefined()
    expect(env2.zap.localhostAlias).toBe('gw')
  })
  it('rejects non-integer minutes', () => {
    expect(() =>
      parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_NUCLEI_MAX_MINUTES: 'ten' }),
    ).toThrow(EnvError)
  })

  it('reads SAKUDA_NUCLEI_CONCURRENCY and rejects a non-positive value', () => {
    expect(
      parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_NUCLEI_CONCURRENCY: '8' }).nuclei.concurrency,
    ).toBe(8)
    expect(() => parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_NUCLEI_CONCURRENCY: '0' })).toThrow(
      EnvError,
    )
  })

  describe('resolving relative executable paths (C2)', () => {
    it('leaves a bare name (PATH lookup) untouched', () => {
      const env = parseEnv({
        SAKUDA_ENCRYPTION_KEY: key,
        SAKUDA_ZAP_CMD: 'zap.sh',
        SAKUDA_NUCLEI_BIN: 'nuclei',
      })
      expect(env.zap.cmd).toBe('zap.sh')
      expect(env.nuclei.bin).toBe('nuclei')
    })

    it('resolves a relative path containing a separator against process.cwd()', () => {
      const env = parseEnv({
        SAKUDA_ENCRYPTION_KEY: key,
        SAKUDA_ZAP_CMD: './scripts/zap-docker.sh',
        SAKUDA_NUCLEI_BIN: './bin/nuclei',
      })
      expect(env.zap.cmd).toBe(resolve(process.cwd(), './scripts/zap-docker.sh'))
      expect(env.nuclei.bin).toBe(resolve(process.cwd(), './bin/nuclei'))
    })

    it('leaves an already-absolute path untouched', () => {
      const env = parseEnv({
        SAKUDA_ENCRYPTION_KEY: key,
        SAKUDA_ZAP_CMD: '/zap/zap.sh',
        SAKUDA_NUCLEI_BIN: '/usr/local/bin/nuclei',
      })
      expect(env.zap.cmd).toBe('/zap/zap.sh')
      expect(env.nuclei.bin).toBe('/usr/local/bin/nuclei')
    })
  })
})

describe('SAKUDA_NUCLEI_DAST_TEMPLATES', () => {
  it('overrides the DAST template tree independently of the signature templates', () => {
    const env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_NUCLEI_TEMPLATES: '/tpl/http',
      SAKUDA_NUCLEI_DAST_TEMPLATES: '/tpl/dast',
    })
    expect(env.nuclei.templatesDir).toBe('/tpl/http')
    expect(env.nuclei.dastTemplatesDir).toBe('/tpl/dast')
  })

  it('rejects an explicitly empty DAST template path (fail fast, not a silent passive fallback)', () => {
    expect(() =>
      parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_NUCLEI_DAST_TEMPLATES: '   ' }),
    ).toThrow(/SAKUDA_NUCLEI_DAST_TEMPLATES must not be empty/)
  })
  describe('SAKUDA_HTTPX_PRUNE_STATUS_CODES (#91)', () => {
    it('is off (empty) by default and on an empty value', () => {
      expect(parseEnv({ SAKUDA_ENCRYPTION_KEY: key }).httpx.pruneStatusCodes).toEqual([])
      expect(
        parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_HTTPX_PRUNE_STATUS_CODES: ' ' }).httpx
          .pruneStatusCodes,
      ).toEqual([])
    })
    it('parses a comma-separated list of 4xx codes', () => {
      expect(
        parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_HTTPX_PRUNE_STATUS_CODES: '404, 410' }).httpx
          .pruneStatusCodes,
      ).toEqual([404, 410])
    })
    it('fails fast on a code that is never evidence of a dead path (405, 429, 5xx, 2xx)', () => {
      for (const v of ['405', '429', '500', '200', '404,503', 'abc'])
        expect(() =>
          parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_HTTPX_PRUNE_STATUS_CODES: v }),
        ).toThrow(EnvError)
    })
  })
  it('SAKUDA_MCP_API_KEY is retired: ignored by parseEnv, reported by name only (#20)', () => {
    const legacy = 'k9-legacy-secret'
    expect(() => parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_MCP_API_KEY: legacy })).not.toThrow()
    expect(parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_MCP_API_KEY: legacy })).not.toHaveProperty(
      'mcpApiKey',
    )
    const warnings = retiredEnvWarnings({ SAKUDA_MCP_API_KEY: legacy })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/SAKUDA_MCP_API_KEY .*ignored/)
    expect(warnings[0]).not.toContain(legacy)
    expect(retiredEnvWarnings({})).toEqual([])
    expect(retiredEnvWarnings({ SAKUDA_MCP_API_KEY: '  ' })).toEqual([])
  })
  it('SAKUDA_CAPTURE_CDP_URL defaults to loopback, accepts http(s) only, trims a trailing slash (#17)', () => {
    expect(parseEnv({ SAKUDA_ENCRYPTION_KEY: key }).captureCdpUrl).toBe('http://127.0.0.1:9222')
    expect(parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_CAPTURE_CDP_URL: '' }).captureCdpUrl).toBe(
      'http://127.0.0.1:9222',
    )
    expect(
      parseEnv({
        SAKUDA_ENCRYPTION_KEY: key,
        SAKUDA_CAPTURE_CDP_URL: 'http://host.docker.internal:9222/',
      }).captureCdpUrl,
    ).toBe('http://host.docker.internal:9222')
    expect(() =>
      parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_CAPTURE_CDP_URL: 'file:///etc/passwd' }),
    ).toThrow(EnvError)
  })
  it('SAKUDA_ALLOWED_HOSTS is empty by default and lists bare, lowercased hostnames (#22)', () => {
    expect(parseEnv({ SAKUDA_ENCRYPTION_KEY: key }).allowedHosts).toEqual([])
    expect(
      parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_ALLOWED_HOSTS: ' , ' }).allowedHosts,
    ).toEqual([])
    expect(
      parseEnv({
        SAKUDA_ENCRYPTION_KEY: key,
        SAKUDA_ALLOWED_HOSTS: 'Sakuda.LAN, 192.168.1.5,[fd00::1]',
      }).allowedHosts,
    ).toEqual(['sakuda.lan', '192.168.1.5', '[fd00::1]'])
  })
  it.each([
    'sakuda.lan:3000',
    'sakuda.lan/x',
    '*',
    '*.lan',
    'user@sakuda.lan',
    'fd00::1',
    'bücher.example',
  ])('SAKUDA_ALLOWED_HOSTS rejects %s at startup (#22)', (value) => {
    expect(() => parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_ALLOWED_HOSTS: value })).toThrow(
      /SAKUDA_ALLOWED_HOSTS/,
    )
  })
  it('allowedHostsWarnings names the extra hosts only when some are set (#22)', () => {
    expect(allowedHostsWarnings({ allowedHosts: [] })).toEqual([])
    const warnings = allowedHostsWarnings({ allowedHosts: ['sakuda.lan', '192.168.1.5'] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('sakuda.lan, 192.168.1.5')
    expect(warnings[0]).toContain('/mcp stays loopback-only')
  })
})

describe('SAKUDA_OAST / SAKUDA_OAST_TOKEN (#35)', () => {
  const oastOf = (raw: Record<string, string>) =>
    parseEnv({ SAKUDA_ENCRYPTION_KEY: key, ...raw }).nuclei.oast

  it('defaults to the public interactsh servers (nuclei’s own default), also when empty', () => {
    expect(oastOf({})).toEqual({ mode: 'public' })
    expect(oastOf({ SAKUDA_OAST: '  ' })).toEqual({ mode: 'public' })
    expect(oastOf({ SAKUDA_OAST: 'public' })).toEqual({ mode: 'public' })
  })

  it('off disables OAST', () => {
    expect(oastOf({ SAKUDA_OAST: 'off' })).toEqual({ mode: 'off' })
  })

  it('an http(s) URL selects a self-hosted server, with an optional token', () => {
    expect(oastOf({ SAKUDA_OAST: 'https://oast.example.test/' })).toEqual({
      mode: 'self-hosted',
      serverUrl: 'https://oast.example.test',
      token: undefined,
    })
    expect(oastOf({ SAKUDA_OAST: 'http://10.0.0.5:8080', SAKUDA_OAST_TOKEN: 'tok-123' })).toEqual({
      mode: 'self-hosted',
      serverUrl: 'http://10.0.0.5:8080',
      token: 'tok-123',
    })
  })

  it.each([
    'on',
    'ftp://oast.example.test',
    'oast.example.test',
    'https://user:pw@oast.example.test',
  ])('rejects SAKUDA_OAST=%s at startup', (value) => {
    expect(() => oastOf({ SAKUDA_OAST: value })).toThrow(/SAKUDA_OAST/)
  })

  it.each(['public', 'off'])(
    'rejects a token when SAKUDA_OAST=%s (it would silently go unused)',
    (mode) => {
      expect(() => oastOf({ SAKUDA_OAST: mode, SAKUDA_OAST_TOKEN: 'tok-123' })).toThrow(
        /SAKUDA_OAST_TOKEN/,
      )
    },
  )

  it('never echoes the token in the startup error', () => {
    expect(() => oastOf({ SAKUDA_OAST: 'off', SAKUDA_OAST_TOKEN: 'tok-secret-xyz' })).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining('tok-secret-xyz') }),
    )
  })
})
