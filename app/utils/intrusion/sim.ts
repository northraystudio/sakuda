import type { Engine } from '#shared/types/api'
import type { IntrusionHud, IntrusionOutcome } from './hud'

/**
 * The intrusion simulation: plain data plus step functions, no DOM. Every
 * pool (packets, sparks, pop-ups) is allocated once in {@link createSim} and
 * recycled, so a frame allocates nothing; strings are only built on events.
 *
 * Data never moves the picture directly: {@link syncSim} turns the HUD into
 * targets (segments to break, hits to flash), and {@link stepSim} animates
 * toward them.
 */

/** Logical canvas size; the component scales it to the element's width. */
export const SIM_W = 320
export const SIM_H = 160

// Left rail: one lane per engine, in run order.
export const LANE_X = 8
export const LANE_W = 92
const LANES_TOP = 24
const LANES_BOTTOM = SIM_H - 40
const LANE_GAP = 6
const LANE_MAX_H = 24

// Right: the target and its defense rings, outermost first.
export const TARGET_X = 262
export const TARGET_Y = 66
export const RINGS = [
  { r: 46, segments: 14 },
  { r: 34, segments: 10 },
  { r: 23, segments: 7 },
] as const
/** Ellipse squash so the rings read as a tilted shield. */
export const RING_SQUASH = 0.9
export const SEGMENT_COUNT = RINGS.reduce((n, r) => n + r.segments, 0)
/** The core ring only falls when the scan completes. */
const CORE_SEGMENTS = RINGS[RINGS.length - 1]!.segments

export const LOG_LINES = 3
const PACKET_EVERY_MS = 140
const PACKET_FLIGHT_MS = 700
const BREAK_EVERY_MS = 90
const FINALE_BREAK_EVERY_MS = 40
export const SPARK_MS = 500
export const POP_MS = 900
const FLASH_MS = 400
const BANNER_MS = 2200
const MAX_PACKETS = 8
const MAX_SPARKS = 48
const MAX_POPS = 4

export type LogKind = 'stage' | 'launch' | 'hit' | 'ok' | 'fail'
export interface LogLine {
  text: string
  kind: LogKind
  engine: Engine | null
}

export interface Packet {
  active: boolean
  lane: number
  /** Flight progress 0–1. */
  t: number
  /** Phase of the wobble, so packets don't fly in lockstep. */
  wobble: number
}

export interface Spark {
  active: boolean
  x: number
  y: number
  vx: number
  vy: number
  ageMs: number
  /** Pink for a finding, white for breaking defenses. */
  hit: boolean
}

export interface Pop {
  active: boolean
  x: number
  ageMs: number
}

export interface SimState {
  timeMs: number
  synced: boolean
  laneCount: number
  /** Lane attacking now, -1 while queued. */
  active: number
  stage: string | null
  broken: Uint8Array
  brokenCount: number
  /** Segments the data says should be broken; animation catches up. */
  targetBroken: number
  breakAccMs: number
  fireAccMs: number
  packets: Packet[]
  sparks: Spark[]
  pops: Pop[]
  flashMs: number
  bannerUntilMs: number
  findingsSeen: number
  outcome: IntrusionOutcome | null
  /** Newest last; at most {@link LOG_LINES}. */
  logs: LogLine[]
}

export function createSim(): SimState {
  return {
    timeMs: 0,
    synced: false,
    laneCount: 0,
    active: -1,
    stage: null,
    broken: new Uint8Array(SEGMENT_COUNT),
    brokenCount: 0,
    targetBroken: 0,
    breakAccMs: 0,
    fireAccMs: 0,
    packets: Array.from({ length: MAX_PACKETS }, () => ({
      active: false,
      lane: 0,
      t: 0,
      wobble: 0,
    })),
    sparks: Array.from({ length: MAX_SPARKS }, () => ({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      ageMs: 0,
      hit: false,
    })),
    pops: Array.from({ length: MAX_POPS }, () => ({ active: false, x: 0, ageMs: 0 })),
    flashMs: 0,
    bannerUntilMs: 0,
    findingsSeen: 0,
    outcome: null,
    logs: [],
  }
}

/** Top and height of lane `i` of `n`; lanes shrink to fit up to four. */
export function laneBox(i: number, n: number): { y: number; h: number } {
  const h = Math.min(LANE_MAX_H, (LANES_BOTTOM - LANES_TOP - LANE_GAP * (n - 1)) / Math.max(n, 1))
  return { y: LANES_TOP + i * (h + LANE_GAP), h }
}

/** Center of segment `i` (outer ring first). */
export function segmentCenter(i: number): [number, number] {
  let k = i
  for (const ring of RINGS) {
    if (k < ring.segments) {
      const a = ((k + 0.5) / ring.segments) * Math.PI * 2
      return [TARGET_X + Math.cos(a) * ring.r, TARGET_Y + Math.sin(a) * ring.r * RING_SQUASH]
    }
    k -= ring.segments
  }
  return [TARGET_X, TARGET_Y]
}

/** Radius of the outermost ring still standing — where packets hit. */
export function shieldRadius(s: SimState): number {
  let k = 0
  for (const ring of RINGS) {
    for (let j = 0; j < ring.segments; j++) if (!s.broken[k + j]) return ring.r
    k += ring.segments
  }
  return 10
}

export function bannerVisible(s: SimState): boolean {
  return s.timeMs < s.bannerUntilMs
}

function log(s: SimState, text: string, kind: LogKind, engine: Engine | null): void {
  s.logs.push({ text, kind, engine })
  if (s.logs.length > LOG_LINES) s.logs.shift()
}

function spawnSparks(s: SimState, x: number, y: number, n: number, hit: boolean): void {
  for (const sp of s.sparks) {
    if (n <= 0) return
    if (sp.active) continue
    const a = Math.random() * Math.PI * 2
    const v = 0.02 + Math.random() * 0.05
    sp.active = true
    sp.x = x
    sp.y = y
    sp.vx = Math.cos(a) * v
    sp.vy = Math.sin(a) * v
    sp.ageMs = 0
    sp.hit = hit
    n--
  }
}

function hit(s: SimState, total: number, engine: Engine | null): void {
  s.flashMs = FLASH_MS
  const pop = s.pops.find((p) => !p.active) ?? s.pops[0]!
  pop.active = true
  pop.x = TARGET_X - 6 + Math.random() * 12
  pop.ageMs = 0
  spawnSparks(s, TARGET_X, TARGET_Y, 10, true)
  // Consecutive hits share one line instead of flooding the terminal.
  const text = `> ${engine ?? 'scan'} :: vuln matched (total ${total})`
  const last = s.logs[s.logs.length - 1]
  if (last?.kind === 'hit') last.text = text
  else log(s, text, 'hit', engine)
}

/** Brings the simulation in line with the HUD: a new phase raises the
 * banner, stages and findings go to the terminal, progress becomes segments
 * owed, and a terminal outcome starts the finale. Never repairs a segment. */
export function syncSim(s: SimState, hud: IntrusionHud, stage: string | null): void {
  s.laneCount = hud.lanes.length
  const engine = hud.active >= 0 ? hud.lanes[hud.active]!.engine : null

  if (hud.active !== s.active) {
    const prev = s.active >= 0 ? hud.lanes[s.active] : undefined
    if (prev && prev.state !== 'running' && prev.state !== 'queued')
      log(s, `> ${prev.engine} :: ${prev.state} (${prev.findings} vuln)`, 'ok', prev.engine)
    s.active = hud.active
    s.stage = null
    if (engine && !hud.outcome) {
      log(s, `> launching ${engine} ...`, 'launch', engine)
      s.bannerUntilMs = s.timeMs + BANNER_MS
    }
  }
  if (stage && stage !== s.stage && !hud.outcome) {
    s.stage = stage
    log(s, `> ${engine} :: ${stage}`, 'stage', engine)
  }

  // The first sync adopts the findings so far; only new ones flash.
  if (s.synced && hud.findings > s.findingsSeen) hit(s, hud.findings, engine)
  s.findingsSeen = Math.max(s.findingsSeen, hud.findings)

  if (hud.outcome && !s.outcome) {
    s.outcome = hud.outcome
    s.bannerUntilMs = 0
    if (hud.outcome === 'complete') log(s, '> all phases complete', 'ok', null)
    else log(s, `> ${engine ?? 'scan'} :: connection lost`, 'fail', engine)
  }

  const want =
    s.outcome === 'complete'
      ? SEGMENT_COUNT
      : Math.min(SEGMENT_COUNT - CORE_SEGMENTS, Math.floor(hud.progress * SEGMENT_COUNT))
  s.targetBroken = Math.max(s.targetBroken, want)
  s.synced = true
}

function breakNext(s: SimState): void {
  const i = s.brokenCount
  s.broken[i] = 1
  s.brokenCount++
  const [x, y] = segmentCenter(i)
  spawnSparks(s, x, y, 6, false)
}

/** Instantly applies every owed break — for reduced motion, where nothing
 * animates and each data change is drawn as one still frame. */
export function settleSim(s: SimState): void {
  while (s.brokenCount < s.targetBroken) {
    s.broken[s.brokenCount] = 1
    s.brokenCount++
  }
  for (const p of s.packets) p.active = false
  for (const sp of s.sparks) sp.active = false
  for (const p of s.pops) p.active = false
  s.flashMs = 0
}

/** True once the finale has nothing left to animate — the loop may stop. */
export function isSettled(s: SimState): boolean {
  if (!s.outcome) return false
  return (
    s.brokenCount >= s.targetBroken &&
    s.flashMs <= 0 &&
    !s.packets.some((p) => p.active) &&
    !s.sparks.some((sp) => sp.active) &&
    !s.pops.some((p) => p.active)
  )
}

export function stepSim(s: SimState, dtMs: number): void {
  s.timeMs += dtMs

  s.breakAccMs += dtMs
  const breakEvery = s.outcome === 'complete' ? FINALE_BREAK_EVERY_MS : BREAK_EVERY_MS
  if (s.brokenCount >= s.targetBroken) s.breakAccMs = 0
  while (s.brokenCount < s.targetBroken && s.breakAccMs >= breakEvery) {
    s.breakAccMs -= breakEvery
    breakNext(s)
  }

  // Packets only fly while an engine is attacking.
  if (!s.outcome && s.active >= 0) {
    s.fireAccMs += dtMs
    if (s.fireAccMs >= PACKET_EVERY_MS) {
      s.fireAccMs = 0
      const p = s.packets.find((x) => !x.active)
      if (p) {
        p.active = true
        p.lane = s.active
        p.t = 0
        p.wobble = Math.random() * Math.PI * 2
      }
    }
  }
  for (const p of s.packets) {
    if (!p.active) continue
    p.t += dtMs / PACKET_FLIGHT_MS
    if (p.t >= 1) {
      p.active = false
      if (Math.random() < 0.3) spawnSparks(s, TARGET_X - shieldRadius(s), TARGET_Y, 2, false)
    }
  }

  for (const sp of s.sparks) {
    if (!sp.active) continue
    sp.ageMs += dtMs
    sp.x += sp.vx * dtMs
    sp.y += sp.vy * dtMs
    if (sp.ageMs > SPARK_MS) sp.active = false
  }
  for (const p of s.pops) {
    if (!p.active) continue
    p.ageMs += dtMs
    if (p.ageMs > POP_MS) p.active = false
  }
  s.flashMs = Math.max(0, s.flashMs - dtMs)
}
