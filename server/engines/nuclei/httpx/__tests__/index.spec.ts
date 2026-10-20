import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realSleep } from 'node:timers/promises'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError } from '../../../types'
import { probeTargets, type HttpxProbeInput } from '../index'

// Fake httpx that never finishes on its own — only the cap stops it. Writes
// one line first (synchronously: a piped console.log is still buffered when
// SIGTERM lands) so the timed-out path still has something to annotate.
const FAKE_HANGS_LINE = JSON.stringify({ input: 'http://h/a', status_code: 200, failed: false })
const FAKE_HANGS = `#!/usr/bin/env node
require('node:fs').writeSync(1, ${JSON.stringify(FAKE_HANGS_LINE)} + '\\n')
setInterval(() => {}, 1000)
`

const FAKE_CRASHES = `#!/usr/bin/env node
console.error('boom')
process.exit(1)
`

// Exits 1 after reporting a 404 — a failed run's observations are recorded
// but never acted on.
const FAKE_OUTPUT_THEN_FAILS = `#!/usr/bin/env node
console.log(JSON.stringify({ input: 'http://h/a', status_code: 404, failed: false }))
process.exit(1)
`

function writeFakeBin(dir: string, content: string): string {
  const p = join(dir, `fake-httpx-${randomBytes(4).toString('hex')}.js`)
  writeFileSync(p, content)
  chmodSync(p, 0o755)
  return p
}

describe('probeTargets', () => {
  let tmp: string
  const logger = pino({ level: 'silent' })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sakuda-httpx-'))
  })

  function input(overrides: Partial<HttpxProbeInput>): HttpxProbeInput {
    return {
      scanId: 'scan-1',
      targetUrls: ['http://h/a', 'http://h/b'],
      workDir: join(tmp, 'work'),
      bin: '/nonexistent/sakuda-test/httpx',
      timeoutMs: 60_000,
      threads: 2,
      rateLimit: 10,
      headersConfigFile: null,
      pruneStatusCodes: [404],
      signal: new AbortController().signal,
      logger,
      ...overrides,
    }
  }

  it('passes everything through as `unavailable` when the binary is missing', async () => {
    const r = await probeTargets(input({}))
    expect(r.kept).toEqual(['http://h/a', 'http://h/b'])
    expect(r.meta).toMatchObject({
      status: 'unavailable',
      keptCount: 2,
      droppedCount: 0,
      exitCode: null,
    })
    expect(r.warnings).toEqual([expect.stringMatching(/did not run.*not installed/)])
    // the artifacts were still prepared, so the operator can see what would have run
    expect(existsSync(join(tmp, 'work', 'httpx', 'args.json'))).toBe(true)
  })

  it('passes everything through as `timedOut` when the cap stops it, keeping what it saw', async () => {
    // The cap is runCommand's setTimeout, armed at spawn. On a busy machine
    // the fake's Node startup can outlast it, so the cap would fire before
    // the line is written (#31). Fake only the timers, wait in real time for
    // the line to reach stdout.jsonl, then fire the cap ourselves.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let r
    try {
      const pending = probeTargets(input({ bin: writeFakeBin(tmp, FAKE_HANGS), timeoutMs: 2_000 }))
      const stdoutPath = join(tmp, 'work', 'httpx', 'stdout.jsonl')
      while (!(
        existsSync(stdoutPath) && readFileSync(stdoutPath, 'utf8').includes(FAKE_HANGS_LINE)
      ))
        await realSleep(20)
      vi.advanceTimersByTime(2_000)
      r = await pending
    } finally {
      vi.useRealTimers()
    }
    expect(r.kept).toEqual(['http://h/a', 'http://h/b'])
    expect(r.meta).toMatchObject({
      status: 'timedOut',
      keptCount: 2,
      droppedCount: 0,
      observedCount: 1,
      statusCounts: { '200': 1 },
    })
    expect(r.warnings).toEqual([expect.stringMatching(/stopped after/)])
  }, 15_000)

  it('passes everything through as `failed` on a non-zero exit, even with a prunable line', async () => {
    const r = await probeTargets(input({ bin: writeFakeBin(tmp, FAKE_OUTPUT_THEN_FAILS) }))
    expect(r.kept).toEqual(['http://h/a', 'http://h/b'])
    expect(r.meta).toMatchObject({
      status: 'failed',
      exitCode: 1,
      droppedCount: 0,
      statusCounts: { '404': 1 },
    })
    expect(r.warnings).toEqual([expect.stringMatching(/failed \(exit 1/)])
  })

  it('names the stderr log in the failure warning', async () => {
    const r = await probeTargets(input({ bin: writeFakeBin(tmp, FAKE_CRASHES) }))
    expect(r.warnings[0]).toContain(join(tmp, 'work', 'httpx', 'stderr.log'))
    expect(readFileSync(join(tmp, 'work', 'httpx', 'stderr.log'), 'utf8')).toContain('boom')
  })

  it('stops (throws) rather than passing through when the scan is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      probeTargets(input({ bin: writeFakeBin(tmp, FAKE_HANGS), signal: ac.signal })),
    ).rejects.toThrow(EngineError)
  })
})
