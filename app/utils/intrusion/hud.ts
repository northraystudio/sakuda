import type { Engine, EngineProgressView, EngineRunView } from '#shared/types/api'
import { orderEngines } from '#shared/utils/engines'

export type IntrusionOutcome = 'complete' | 'lost'
export type LaneState = 'queued' | 'running' | 'done' | 'failed' | 'skipped'

export interface IntrusionInput {
  status: string
  engines: readonly Engine[]
  engineRuns: readonly EngineRunView[]
  /** The running engine's self-reported progress (`GET /api/scans/:id/progress`). */
  progress: EngineProgressView | null
  now: Date
}

/** One engine on the left-hand rail, in run order. */
export interface Lane {
  engine: Engine
  state: LaneState
  /** Findings so far: the run's counts, or live matches while it runs. */
  findings: number
}

/** Everything the visualizer shows, derived from the polled scan alone — the
 * canvas never decides anything about the scan itself. */
export interface IntrusionHud {
  lanes: Lane[]
  /** Index into `lanes` of the engine attacking now (or that attacked last);
   * -1 while queued. */
  active: number
  /** 1-based phase = active + 1; 0 while queued. */
  phase: number
  findings: number
  /** Share (0–1) of the target's defenses broken. Stays below 1 until the
   * last engine actually finishes — only completion breaks the core. */
  progress: number
  outcome: IntrusionOutcome | null
}

/** Ceiling for any estimate while the engine is still running. */
export const RUNNING_PROGRESS_CAP = 0.9

function totalCount(run: EngineRunView): number {
  const c = run.counts
  return c.critical + c.high + c.medium + c.low + c.info
}

/** Estimated share of a running engine's work. The engine's own percent is
 * used when it reports one; otherwise elapsed time against its time budget,
 * square-rooted so the defenses visibly crack early instead of crawling
 * toward a budget the engine usually finishes well inside. */
export function runningProgress(
  run: EngineRunView,
  progress: EngineProgressView | null,
  now: Date,
): number {
  const budgetMs = run.limits.totalMinutes * 60_000
  const elapsedMs = now.getTime() - new Date(run.startedAt).getTime()
  const byTime =
    budgetMs > 0 && Number.isFinite(elapsedMs) && elapsedMs > 0
      ? Math.sqrt(Math.min(elapsedMs / budgetMs, 1))
      : 0
  const reported =
    progress && progress.engine === run.engine && progress.percent !== null
      ? progress.percent / 100
      : 0
  return Math.min(Math.max(byTime, reported), 1) * RUNNING_PROGRESS_CAP
}

export function deriveIntrusionHud(input: IntrusionInput): IntrusionHud {
  const lanes: Lane[] = orderEngines(input.engines).map((engine) => {
    const run = input.engineRuns.find((r) => r.engine === engine)
    if (!run) return { engine, state: 'queued', findings: 0 }
    if (run.status !== 'running') return { engine, state: run.status, findings: totalCount(run) }
    const live = input.progress?.engine === engine ? (input.progress.matched ?? 0) : 0
    return { engine, state: 'running', findings: live }
  })

  const running = lanes.findIndex((l) => l.state === 'running')
  const finished = lanes.filter((l) => l.state !== 'queued' && l.state !== 'running').length
  let active: number
  if (input.status === 'queued' || lanes.length === 0) active = -1
  else if (running >= 0) active = running
  // Between two engines, or finished: the last engine that ran holds the link.
  else active = Math.min(Math.max(finished - 1, 0), lanes.length - 1)

  const runningRun =
    running >= 0 ? input.engineRuns.find((r) => r.engine === lanes[running]!.engine) : undefined
  const share = runningRun ? runningProgress(runningRun, input.progress, input.now) : 0
  const progress = lanes.length === 0 ? 0 : Math.min((finished + share) / lanes.length, 1)

  return {
    lanes,
    active,
    phase: active + 1,
    findings: lanes.reduce((sum, l) => sum + l.findings, 0),
    progress,
    outcome: input.status === 'done' ? 'complete' : input.status === 'failed' ? 'lost' : null,
  }
}

/** The finale to play when the watched status changes: only a transition
 * seen on this page (active → terminal) earns one, so opening an already
 * finished scan goes straight to the report. */
export function finaleFor(
  prev: string | undefined,
  next: string | undefined,
): IntrusionOutcome | null {
  const wasActive = prev === 'queued' || prev === 'running'
  if (!wasActive) return null
  if (next === 'done') return 'complete'
  if (next === 'failed') return 'lost'
  return null
}
