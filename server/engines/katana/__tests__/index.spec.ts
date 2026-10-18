import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseEnv, type Env } from '../../../config/env'
import type { SiteWithHeaders } from '../../../services/siteService'
import { SpawnError } from '../../runCommand'
import { EngineError } from '../../types'
import { KATANA_OUTPUT_FILE, KATANA_WORK_SUBDIR, runKatanaCrawl } from '../index'

// Fake katana: records argv, reads the -list seeds file and the -o output
// path, writes a JSONL crawl of the first seed's origin (real endpoints, one
// asset, one excluded path, one off-origin URL, two regex artifacts), exits 0.
const FAKE_SUCCESS = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(args))
// what the -config file held while katana ran (it is removed afterwards)
if (args.includes('-config'))
  fs.copyFileSync(args[args.indexOf('-config') + 1], path.join(process.cwd(), 'seen-config.json'))
const outFile = args[args.indexOf('-o') + 1]
const seedsFile = args[args.indexOf('-list') + 1]
const origin = new URL(fs.readFileSync(seedsFile, 'utf8').trim().split('\\n')[0]).origin
const lines = [
  { request: { method: 'GET', endpoint: origin + '/' }, response: { status_code: 200 } },
  { request: { method: 'GET', endpoint: origin + '/api/Feedbacks' }, response: { status_code: 200 } },
  { request: { method: 'GET', endpoint: origin + '/rest/user/whoami' }, response: { status_code: 401 } },
  { request: { method: 'GET', endpoint: origin + '/rest/user/whoami' }, response: { status_code: 401 } },
  { request: { method: 'GET', endpoint: origin + '/main.js' }, response: { status_code: 200 } },
  { request: { method: 'GET', endpoint: origin + '/admin/config' }, response: { status_code: 200 } },
  { request: { method: 'GET', endpoint: 'http://other.example/leak' }, response: { status_code: 200 } },
  { request: { method: 'GET', endpoint: origin + '/api/%5C%22/' }, response: { status_code: 404 } },
  { request: { method: 'GET', endpoint: origin + '/i.visualViewport.scale/i.document.do' } },
]
fs.writeFileSync(outFile, lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n' + 'garbage\\n')
process.exit(0)
`

const FAKE_FAILURE = `#!/usr/bin/env node
console.error('katana: bad flag')
process.exit(2)
`

// Sleeps well past the test's timeout budget so runCommand has to kill it.
// It writes nothing itself: a test that needs a partial result puts it in the
// output file before starting it, so the result exists however slowly this
// process starts (#23).
const FAKE_HANG = `#!/usr/bin/env node
setTimeout(() => {}, 60000)
`

function writeFakeBin(dir: string, name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  chmodSync(p, 0o755)
  return p
}

const key = randomBytes(32).toString('base64')
const logger = pino({ level: 'silent' })

function baseSite(overrides: Partial<SiteWithHeaders> = {}): SiteWithHeaders {
  return {
    id: 'site-1',
    name: 'shop',
    frontBaseUrl: 'http://localhost:3000',
    apiBaseUrl: null,
    nucleiPaths: '',
    openapiUrl: null,
    openapiJson: null,
    zapFeSeedPath: '/',
    discoverySeedPaths: '',
    crawlScopePaths: '',
    excludePaths: '/admin/*',
    nucleiRateLimit: 50,
    zapApiMaxMinutes: 45,
    zapFeSpiderMaxMinutes: 5,
    nonLocalConfirmed: false,
    allowMutatingRequests: false,
    nucleiEnabledRiskTags: [],
    headerNames: [],
    browserStorageNames: [],
    requiresConfirmation: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    headers: [],
    browserStorage: [],
    ...overrides,
  }
}

function envWith(tmp: string, bin: string, extra: Record<string, string> = {}): Env {
  return parseEnv({
    SAKUDA_ENCRYPTION_KEY: key,
    SAKUDA_KATANA_BIN: bin,
    SAKUDA_DATA_DIR: tmp,
    SAKUDA_ENGINE_GRACE_MINUTES: '0',
    ...extra,
  })
}

describe('runKatanaCrawl', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sakuda-katana-'))
  })

  it('runs the fake binary in a sub-dir, drops katana junk, then applies the shared normalization', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-katana.js', FAKE_SUCCESS)
    const workDir = join(tmp, 'work')
    const site = baseSite({
      discoverySeedPaths: '/\n/#/search',
      headers: [{ name: 'Cookie', value: 'token=secret' }],
      headerNames: ['Cookie'],
    })

    const out = await runKatanaCrawl({
      discoveryId: 'disc-1',
      site,
      workDir,
      env: envWith(tmp, fakeBin),
      logger,
      signal: new AbortController().signal,
    })

    expect(out.urls).toEqual([
      { url: 'http://localhost:3000/', method: 'GET', statusCode: 200, source: 'katana' },
      {
        url: 'http://localhost:3000/api/Feedbacks',
        method: 'GET',
        statusCode: 200,
        source: 'katana',
      },
      {
        url: 'http://localhost:3000/rest/user/whoami',
        method: 'GET',
        statusCode: 401,
        source: 'katana',
      },
    ])
    expect(out.meta).toMatchObject({
      maxDepth: 3,
      maxMinutes: 5,
      rawCount: 9,
      urlCount: 3,
      dropped: {
        invalid: 0,
        sameOriginOnly: 1,
        outOfScope: 0,
        asset: 1,
        noise: 0,
        excluded: 1,
        capped: 0,
        noResponse: 1,
        artifact: 1,
      },
      timedOut: false,
      exitCode: 0,
    })
    expect(out.warnings).toEqual(["1 unparsable line(s) in katana's output were ignored"])

    // Everything katana touches lives under <workDir>/katana, away from ZAP's files.
    const katanaDir = join(workDir, 'katana')
    expect(readFileSync(join(katanaDir, 'seeds.txt'), 'utf8')).toBe(
      'http://localhost:3000/\nhttp://localhost:3000/#/search\n',
    )
    const argv: unknown = JSON.parse(readFileSync(join(katanaDir, 'argv.json'), 'utf8'))
    expect(argv).toEqual([
      '-list',
      join(katanaDir, 'seeds.txt'),
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
      join(katanaDir, 'urls.jsonl'),
      '-silent',
      '-nc',
      '-duc',
      '-eof',
      'raw,body,headers',
      '-config',
      join(katanaDir, 'headers.json'),
    ])
    // the secret reached katana through the 0600 config, which is gone now (#95)
    expect(JSON.stringify(argv)).not.toContain('token=secret')
    expect(JSON.parse(readFileSync(join(katanaDir, 'seen-config.json'), 'utf8'))).toEqual({
      headers: ['Cookie: token=secret'],
    })
    expect(existsSync(join(katanaDir, 'headers.json'))).toBe(false)
  })

  it('rewrites the loopback host for the crawl and restores it in the result', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-katana.js', FAKE_SUCCESS)
    const workDir = join(tmp, 'work')
    const out = await runKatanaCrawl({
      discoveryId: 'disc-1',
      site: baseSite(),
      workDir,
      env: envWith(tmp, fakeBin, { SAKUDA_LOCALHOST_ALIAS: 'host.docker.internal' }),
      logger,
      signal: new AbortController().signal,
    })
    expect(readFileSync(join(workDir, 'katana', 'seeds.txt'), 'utf8')).toBe(
      'http://host.docker.internal:3000/\n',
    )
    expect(out.urls.map((u) => u.url)).toEqual([
      'http://localhost:3000/',
      'http://localhost:3000/api/Feedbacks',
      'http://localhost:3000/rest/user/whoami',
    ])
  })

  it('adds -aff only when active discovery is opted in and ownership is confirmed (three-state gate)', async () => {
    const argvFor = async (site: SiteWithHeaders, dir: string) => {
      const fakeBin = writeFakeBin(tmp, 'fake-katana.js', FAKE_SUCCESS)
      await runKatanaCrawl({
        discoveryId: 'disc-aff',
        site,
        workDir: join(tmp, dir),
        env: envWith(tmp, fakeBin),
        logger,
        signal: new AbortController().signal,
      })
      return JSON.parse(readFileSync(join(tmp, dir, 'katana', 'argv.json'), 'utf8')) as string[]
    }
    // opted out → no -aff
    expect(await argvFor(baseSite(), 'off')).not.toContain('-aff')
    // opted in + local (ownership implicit) → -aff
    expect(await argvFor(baseSite({ allowMutatingRequests: true }), 'on')).toContain('-aff')
    // opted in but non-local and unconfirmed → gate fails closed, no -aff
    expect(
      await argvFor(
        baseSite({
          frontBaseUrl: 'https://staging.example.test',
          allowMutatingRequests: true,
          requiresConfirmation: true,
          nonLocalConfirmed: false,
        }),
        'unconfirmed',
      ),
    ).not.toContain('-aff')
  })

  it('never logs header values', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-katana.js', FAKE_SUCCESS)
    const lines: string[] = []
    const capturing = pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) })
    await runKatanaCrawl({
      discoveryId: 'disc-1',
      site: baseSite({
        headers: [{ name: 'Authorization', value: 'Bearer very-secret' }],
        headerNames: ['Authorization'],
      }),
      workDir: join(tmp, 'work'),
      env: envWith(tmp, fakeBin),
      logger: capturing,
      signal: new AbortController().signal,
    })
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain('very-secret')
    expect(lines.join('\n')).toContain('Authorization')
  })

  it('throws EngineError when the binary exits non-zero with no output', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-katana-fail.js', FAKE_FAILURE)
    await expect(
      runKatanaCrawl({
        discoveryId: 'disc-1',
        site: baseSite(),
        workDir: join(tmp, 'work'),
        env: envWith(tmp, fakeBin),
        logger,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(EngineError)
  })

  it('throws SpawnError when the binary is missing', async () => {
    await expect(
      runKatanaCrawl({
        discoveryId: 'disc-1',
        site: baseSite(),
        workDir: join(tmp, 'work'),
        env: envWith(tmp, join(tmp, 'no-such-katana')),
        logger,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(SpawnError)
  })

  it('keeps the partial result and warns when the engine timeout kills katana', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-katana-hang.js', FAKE_HANG)
    // What katana wrote before it was killed. runKatanaCrawl only mkdirs the
    // work dir, so a line put there first is what it reads back after the kill.
    const katanaDir = join(tmp, 'work', KATANA_WORK_SUBDIR)
    mkdirSync(katanaDir, { recursive: true })
    writeFileSync(
      join(katanaDir, KATANA_OUTPUT_FILE),
      JSON.stringify({
        request: { endpoint: 'http://localhost:3000/partial' },
        response: { status_code: 200 },
      }) + '\n',
    )
    // The real minimum budget is 1 min (+ grace); a fractional value keeps
    // the timeout (minutes * 60_000 ms, grace 0) inside a unit test's patience.
    const out = await runKatanaCrawl({
      discoveryId: 'disc-1',
      site: baseSite({ zapFeSpiderMaxMinutes: 0.025 }),
      workDir: join(tmp, 'work'),
      env: envWith(tmp, fakeBin),
      logger,
      signal: new AbortController().signal,
    })
    expect(out.meta.timedOut).toBe(true)
    expect(out.urls.map((u) => u.url)).toEqual(['http://localhost:3000/partial'])
    expect(out.warnings).toContain(
      'katana was stopped by the engine timeout; its URL list may be partial',
    )
  }, 15_000)

  it('throws when aborted', async () => {
    const fakeBin = writeFakeBin(tmp, 'fake-katana-hang.js', FAKE_HANG)
    const ac = new AbortController()
    const p = runKatanaCrawl({
      discoveryId: 'disc-1',
      site: baseSite(),
      workDir: join(tmp, 'work'),
      env: envWith(tmp, fakeBin),
      logger,
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 300)
    await expect(p).rejects.toThrow(/aborted/)
  }, 15_000)
})
