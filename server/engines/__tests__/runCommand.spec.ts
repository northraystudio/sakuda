import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realSleep } from 'node:timers/promises'
import pino from 'pino'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputStreamError, runCommand, SpawnError } from '../runCommand'

describe('runCommand', () => {
  let tmp: string
  const tmpDirs: string[] = []
  let base: {
    label: string
    cmd: string
    cwd: string
    stdoutPath: string
    stderrPath: string
    logger: pino.Logger
  }

  afterAll(async () => {
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sakuda-'))
    tmpDirs.push(tmp)
    base = {
      label: 't',
      cmd: process.execPath,
      cwd: tmp,
      stdoutPath: join(tmp, 'stdout.log'),
      stderrPath: join(tmp, 'stderr.log'),
      logger: pino({ level: 'silent' }),
    }
  })

  it('captures exit code and streams stdout larger than 1MB to file', async () => {
    const r = await runCommand({
      ...base,
      args: ['-e', "process.stdout.write('x'.repeat(3*1024*1024)); process.exitCode = 3"],
      timeoutMs: 10_000,
    })
    expect(r.code).toBe(3)
    expect(r.signal).toBeNull()
    expect(r.timedOut).toBe(false)
    expect(statSync(base.stdoutPath).size).toBe(3 * 1024 * 1024)
  }, 15_000)

  it('kills the whole process group on timeout (grandchild dies)', async () => {
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)`
    // The cap is armed at spawn. On a busy machine the child's Node startup
    // can outlast it, so the group would be killed before the grandchild's
    // pid is written (#33). Fake only the timers, wait in real time for the
    // pid, then fire the cap ourselves. The SIGKILL grace timer is left
    // unfired: both processes die on SIGTERM.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let r
    try {
      const pending = runCommand({
        ...base,
        args: ['-e', script],
        timeoutMs: 500,
        killGraceMs: 200,
      })
      const pidWritten = (): boolean =>
        existsSync(base.stdoutPath) && readFileSync(base.stdoutPath, 'utf8').includes('\n')
      const waitDeadline = Date.now() + 10_000
      while (!pidWritten() && Date.now() < waitDeadline) await realSleep(20)
      // Fire the cap even when the wait gave up, so the group is still killed
      // rather than left running after the test fails.
      vi.advanceTimersByTime(500)
      r = await pending
    } finally {
      vi.useRealTimers()
    }
    expect(r.timedOut).toBe(true)
    expect(r.signal === 'SIGTERM' || r.signal === 'SIGKILL').toBe(true)
    // An empty stdout would read as pid 0, and kill(0, 0) signals our own
    // group — it never throws, so the check below would fail misleadingly.
    const grandchildPid = Number(readFileSync(base.stdoutPath, 'utf8').trim())
    expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true)
    await new Promise((res) => setTimeout(res, 600))
    expect(() => process.kill(grandchildPid, 0)).toThrow(/ESRCH/)
  }, 15_000)

  it('reports SIGKILL as oomKilled', async () => {
    const r = await runCommand({
      ...base,
      args: ['-e', "process.kill(process.pid,'SIGKILL')"],
      timeoutMs: 5000,
    })
    expect(r.signal).toBe('SIGKILL')
    expect(r.oomKilled).toBe(true)
    expect(r.timedOut).toBe(false)
  }, 10_000)

  it('aborts via AbortSignal', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const r = await runCommand({
      ...base,
      args: ['-e', 'setInterval(()=>{},1000)'],
      timeoutMs: 10_000,
      signal: ac.signal,
    })
    expect(r.aborted).toBe(true)
  }, 15_000)

  it('rejects with SpawnError when the binary does not exist', async () => {
    await expect(
      runCommand({ ...base, cmd: '/nonexistent/bin', args: [], timeoutMs: 1000 }),
    ).rejects.toThrow(SpawnError)
  })

  it('passes arguments literally (no shell expansion)', async () => {
    await runCommand({
      ...base,
      args: ['-e', 'process.stdout.write(process.argv[1])', '$HOME;`id`'],
      timeoutMs: 5000,
    })
    expect(readFileSync(base.stdoutPath, 'utf8')).toBe('$HOME;`id`')
  }, 10_000)

  it('rejects with OutputStreamError when the output stream fails, after the child exits', async () => {
    // Awaiting the promise here already proves the child exited: runCommand
    // only reaches the OutputStreamError throw after `await exit` (the
    // child's 'close' event) has resolved — structurally, not by inference.
    const brokenStdoutPath = join(tmp, 'missing-dir', 'stdout.log')
    await expect(
      runCommand({
        ...base,
        stdoutPath: brokenStdoutPath,
        args: ['-e', 'process.exitCode = 0'],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(OutputStreamError)
  }, 10_000)

  it('strips SAKUDA_ENCRYPTION_KEY from the child even though it is set in the parent (I1)', async () => {
    process.env.SAKUDA_ENCRYPTION_KEY = 'super-secret-master-key'
    try {
      await runCommand({
        ...base,
        args: ['-e', 'process.stdout.write(String(process.env.SAKUDA_ENCRYPTION_KEY))'],
        timeoutMs: 5000,
      })
      expect(readFileSync(base.stdoutPath, 'utf8')).toBe('undefined')
    } finally {
      delete process.env.SAKUDA_ENCRYPTION_KEY
    }
  }, 10_000)

  it('does not report timedOut for a fast exit while output is still flushing', async () => {
    const r = await runCommand({
      ...base,
      args: ['-e', "process.stdout.write('x'.repeat(2*1024*1024)); process.exitCode = 0"],
      timeoutMs: 10_000,
    })
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(0)
  }, 15_000)
})
