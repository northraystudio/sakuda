import { and, eq } from 'drizzle-orm'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '../db/client'
import { engineRuns, scans } from '../db/schema'
import { parseNucleiStats } from '../engines/nuclei/normalize'
import type { Engine, EngineProgressView, ScanProgressView } from '#shared/types/api'

/** Only the end of a log is read: stats/job lines are appended, so the latest
 * one is near the end, and a multi-GB ZAP log must never be pulled into memory
 * on every poll. */
export const PROGRESS_TAIL_BYTES = 64 * 1024

/** nuclei writes one stderr log per phase (see engines/nuclei/index.ts); the
 * stage name comes from this fixed mapping, never from the file system. */
const NUCLEI_STDERR_STAGES: readonly { pattern: RegExp; stage: string }[] = [
  { pattern: /^dast-stderr\.log$/, stage: 'dast' },
  { pattern: /^exposure-stderr\.log$/, stage: 'exposure' },
  { pattern: /^stderr\.log$/, stage: 'signature' },
  { pattern: /^openapi-stderr-\d+\.log$/, stage: 'openapi' },
]

/** The stage a nuclei phase log belongs to, or null for any other file. */
export function nucleiStageOf(fileName: string): string | null {
  return NUCLEI_STDERR_STAGES.find((s) => s.pattern.test(fileName))?.stage ?? null
}

function toBoundedNumber(raw: string | undefined, max: number): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(n, max)
}

/** percent/matched from the latest `-stats-json` line in a nuclei stderr tail. */
export function parseNucleiProgress(tail: string): Pick<EngineProgressView, 'percent' | 'matched'> {
  const stats = parseNucleiStats(tail)
  return {
    percent: toBoundedNumber(stats?.percent, 100),
    matched: toBoundedNumber(stats?.matched, Number.MAX_SAFE_INTEGER),
  }
}

/** ZAP Automation Framework job types sakuda's plans use or ZAP may add
 * around them. A job name outside this list is reported as unknown rather
 * than echoed back. */
const ZAP_JOBS: ReadonlySet<string> = new Set([
  'activeScan',
  'activeScan-config',
  'alertFilter',
  'delay',
  'exitStatus',
  'graphql',
  'openapi',
  'passiveScan-config',
  'passiveScan-wait',
  'replacer',
  'report',
  'requestor',
  'script',
  'soap',
  'spider',
  'spiderAjax',
])

// `progressToStdout: true` (engines/zap/plan.ts) makes ZAP print
// `Job <type> started` / `Job <type> finished, time taken: …` per job.
const ZAP_JOB_STARTED = /^Job (\S+) started\b/

/** The most recently started ZAP job in a stdout tail, or null. */
export function parseZapStage(tail: string): string | null {
  const lines = tail.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = ZAP_JOB_STARTED.exec(lines[i]!.trim())
    if (m) return ZAP_JOBS.has(m[1]!) ? m[1]! : null
  }
  return null
}

/** The last PROGRESS_TAIL_BYTES of a file, or null when it does not exist
 * yet (the engine has not started writing). Any other I/O error propagates. */
export async function readTail(path: string): Promise<string | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (e) {
    // as: fs errors are ErrnoException; ENOENT is the expected "not yet" case.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, PROGRESS_TAIL_BYTES)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    return buf.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function newestNucleiLog(workDir: string): Promise<{ path: string; stage: string } | null> {
  let names: string[]
  try {
    names = await readdir(workDir)
  } catch (e) {
    // as: see readTail.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let newest: { path: string; stage: string; mtimeMs: number } | null = null
  for (const name of names) {
    const stage = nucleiStageOf(name)
    if (!stage) continue
    const path = join(workDir, name)
    let mtimeMs: number
    try {
      ;({ mtimeMs } = await stat(path))
    } catch (e) {
      // as: see readTail. A log removed since readdir is simply not a candidate.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw e
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path, stage, mtimeMs }
  }
  return newest
}

async function readEngineProgress(engine: Engine, workDir: string): Promise<EngineProgressView> {
  const unknown: EngineProgressView = { engine, percent: null, matched: null, stage: null }
  switch (engine) {
    case 'nuclei': {
      const log = await newestNucleiLog(workDir)
      if (!log) return unknown
      const tail = await readTail(log.path)
      return { ...unknown, stage: log.stage, ...(tail ? parseNucleiProgress(tail) : {}) }
    }
    case 'zap-api':
    case 'zap-fe': {
      const tail = await readTail(join(workDir, 'stdout.log'))
      return { ...unknown, stage: tail ? parseZapStage(tail) : null }
    }
    // dalfox runs silenced (engines/dalfox) and prints no progress; boundary
    // runs in-process and writes none.
    case 'dalfox':
    case 'boundary':
      return unknown
    default: {
      const exhaustive: never = engine
      throw new Error(`unhandled engine: ${String(exhaustive)}`)
    }
  }
}

/** The running engine's self-reported progress, or null when the scan does
 * not exist. Reads only the scan's own work dir (`scansDir/<scanId>/<engine>`,
 * the layout scanRunner writes), with `scanId` taken from the DB row. */
export async function getScanProgress(
  db: Db,
  scansDir: string,
  scanId: string,
): Promise<ScanProgressView | null> {
  const scan = db
    .select({ id: scans.id, status: scans.status })
    .from(scans)
    .where(eq(scans.id, scanId))
    .get()
  if (!scan) return null
  const run =
    scan.status === 'running'
      ? db
          .select({ engine: engineRuns.engine })
          .from(engineRuns)
          .where(and(eq(engineRuns.scanId, scan.id), eq(engineRuns.status, 'running')))
          .get()
      : undefined
  if (!run) return { scanId: scan.id, status: scan.status, progress: null }
  const progress = await readEngineProgress(run.engine, join(scansDir, scan.id, run.engine))
  return { scanId: scan.id, status: scan.status, progress }
}
