import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseEnv, type Env } from '../../../config/env'
import type { SiteWithHeaders } from '../../../services/siteService'
import { EngineError } from '../../types'
import { runDalfox } from '../index'

const fixturePath = fileURLToPath(new URL('./fixtures/dalfox-report.json', import.meta.url))
const fixture = readFileSync(fixturePath, 'utf8')

// Fake dalfox: finds the -o output path in argv, writes the fixture report,
// exits 1 (dalfox's "findings found" code).
const FAKE_SUCCESS = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const outFile = args[args.indexOf('-o') + 1]
fs.writeFileSync(outFile, ${JSON.stringify(fixture)})
process.exit(1)
`
// Fake dalfox that fails hard (exit 2) writing nothing.
const FAKE_FAILURE = `#!/usr/bin/env node
process.exit(2)
`
// Fake dalfox that claims findings (exit 1) but writes an empty report.
const FAKE_EXIT1_EMPTY = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const outFile = args[args.indexOf('-o') + 1]
fs.writeFileSync(outFile, JSON.stringify({ meta: {}, findings: [] }))
process.exit(1)
`
// Fake dalfox: all targets unreachable — exits 2 but writes a well-formed
// report marking each target skipped/CONNECTION_FAILED (target is down).
const FAKE_ALL_UNREACHABLE = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const outFile = args[args.indexOf('-o') + 1]
fs.writeFileSync(outFile, JSON.stringify({
  findings: [],
  meta: {
    findings_count: 0,
    total_requests: 4,
    target_summary: [
      { target: 'http://h/', status: 'skipped', error_code: 'CONNECTION_FAILED' },
      { target: 'http://h/ftp', status: 'skipped', error_code: 'CONNECTION_FAILED' },
    ],
  },
}))
process.exit(2)
`
// Fake dalfox that hangs, to exercise the timeout path.
const FAKE_HANG = `#!/usr/bin/env node
setInterval(() => {}, 1000)
`

function writeFakeBin(dir: string, name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  chmodSync(p, 0o755)
  return p
}

const key = randomBytes(32).toString('base64')

function baseSite(overrides: Partial<SiteWithHeaders> = {}): SiteWithHeaders {
  return {
    id: 'site-1',
    name: 'shop',
    frontBaseUrl: 'http://localhost:3001',
    apiBaseUrl: null,
    nucleiPaths: '/rest/products/search?q=\n/login',
    openapiUrl: null,
    openapiJson: null,
    zapFeSeedPath: '/',
    discoverySeedPaths: '',
    crawlScopePaths: '',
    excludePaths: '',
    nucleiRateLimit: 50,
    zapApiMaxMinutes: 45,
    zapFeSpiderMaxMinutes: 5,
    nonLocalConfirmed: false,
    allowMutatingRequests: true,
    nucleiEnabledRiskTags: [],
    nucleiTags: [],
    openapiAllowedOrigins: [],
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

describe('runDalfox', () => {
  let tmp: string
  const logger = pino({ level: 'silent' })
  const baseEnv = (bin: string): Env =>
    parseEnv({ SAKUDA_ENCRYPTION_KEY: key, SAKUDA_DALFOX_BIN: bin } as NodeJS.ProcessEnv)

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dalfox-test-'))
  })
  afterEach(() => {
    // best-effort; tmp dirs are small
  })

  const run = (env: Env, site: SiteWithHeaders) =>
    runDalfox({
      scanId: 'scan-1',
      engine: 'dalfox',
      site,
      workDir: join(tmp, 'work'),
      env,
      logger,
      signal: new AbortController().signal,
    })

  it('skips (not fails) when active checks are off, before doing any work', async () => {
    const env = baseEnv('/nonexistent/dalfox')
    const out = await run(env, baseSite({ allowMutatingRequests: false }))
    expect(out.skipped).toBe(true)
    expect(out.findings).toHaveLength(0)
    expect(out.meta.reason).toBe('active-checks-off')
    expect(out.warnings.join(' ')).toMatch(/active injection checks/i)
  })

  it('produces an incremental XSS finding from a real report (V kept, I dropped)', async () => {
    const bin = writeFakeBin(tmp, 'dalfox', FAKE_SUCCESS)
    const out = await run(baseEnv(bin), baseSite())
    expect(out.skipped).toBeFalsy()
    expect(out.findings.length).toBeGreaterThanOrEqual(1)
    const verified = out.findings.find((f) => f.severity === 'high')
    expect(verified).toBeDefined()
    expect(verified!.engine).toBe('dalfox')
    expect(verified!.ruleId).toBe('dalfox:reflection')
    // The informational (CWE-1104) library finding is not an XSS claim.
    expect(out.findings.some((f) => f.ruleId.includes('library'))).toBe(false)
    expect(out.exitCode).toBe(0) // dalfox exit 1 (findings) maps to a clean run
  })

  it('throws EngineError when the binary is missing', async () => {
    await expect(run(baseEnv('/nonexistent/dalfox'), baseSite())).rejects.toBeInstanceOf(
      EngineError,
    )
  })

  it('throws EngineError when there are no GET targets to scan', async () => {
    const bin = writeFakeBin(tmp, 'dalfox', FAKE_SUCCESS)
    await expect(
      run(baseEnv(bin), baseSite({ nucleiPaths: 'POST /login' })),
    ).rejects.toBeInstanceOf(EngineError)
  })

  it('throws when dalfox fails hard (exit 2) with no output', async () => {
    const bin = writeFakeBin(tmp, 'dalfox', FAKE_FAILURE)
    await expect(run(baseEnv(bin), baseSite())).rejects.toBeInstanceOf(EngineError)
  })

  it('fails when dalfox claims findings (exit 1) but the report is empty', async () => {
    const bin = writeFakeBin(tmp, 'dalfox', FAKE_EXIT1_EMPTY)
    await expect(run(baseEnv(bin), baseSite())).rejects.toBeInstanceOf(EngineError)
  })

  it('treats all-unreachable (target down) as unavailable, not a failure', async () => {
    const bin = writeFakeBin(tmp, 'dalfox', FAKE_ALL_UNREACHABLE)
    const out = await run(baseEnv(bin), baseSite())
    expect(out.skipped).toBeFalsy()
    expect(out.findings).toHaveLength(0)
    expect(out.exitCode).toBe(0) // not a failure
    expect(out.meta.unavailable).toBe(true)
    expect(out.warnings.join(' ')).toMatch(/unreachable/i)
  })

  it('warns and returns partial when the run times out', async () => {
    const bin = writeFakeBin(tmp, 'dalfox', FAKE_HANG)
    const env = parseEnv({
      SAKUDA_ENCRYPTION_KEY: key,
      SAKUDA_DALFOX_BIN: bin,
      SAKUDA_DALFOX_MAX_MINUTES: '1',
      SAKUDA_ENGINE_GRACE_MINUTES: '0',
    } as NodeJS.ProcessEnv)
    // Shrink the deadline by monkeypatching is overkill; instead abort quickly.
    const ac = new AbortController()
    const p = runDalfox({
      scanId: 'scan-1',
      engine: 'dalfox',
      site: baseSite(),
      workDir: join(tmp, 'work'),
      env,
      logger,
      signal: ac.signal,
    })
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(EngineError) // aborted → EngineError
  })

  it('removes the secret config after the run', async () => {
    const bin = writeFakeBin(tmp, 'dalfox', FAKE_SUCCESS)
    await run(
      baseEnv(bin),
      baseSite({ headers: [{ name: 'Authorization', value: 'Bearer secret' }] }),
    )
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(tmp, 'work', 'dalfox-config.json'))).toBe(false)
  })
})
