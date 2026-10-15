<script setup lang="ts">
import type { Engine, EngineProgressView, EngineRunView } from '#shared/types/api'
import { deriveIntrusionHud, type Lane } from '~/utils/intrusion/hud'
import {
  LANE_W,
  LANE_X,
  POP_MS,
  RINGS,
  RING_SQUASH,
  SIM_H,
  SIM_W,
  SPARK_MS,
  TARGET_X,
  TARGET_Y,
  bannerVisible,
  createSim,
  isSettled,
  laneBox,
  settleSim,
  shieldRadius,
  stepSim,
  syncSim,
  type LogKind,
} from '~/utils/intrusion/sim'
import {
  ENGINE_COLOR_TOKENS,
  ENGINE_ICONS,
  ENGINE_SHORT_LABELS,
  FAIL_COLOR_TOKEN,
  HIT_COLOR_TOKEN,
  MUTED_TEXT_TOKEN,
  QUEUED_COLOR_TOKEN,
  SERVER,
  SERVER_COLOR_TOKEN,
  SHIELD_COLOR_TOKEN,
  TERMINAL_COLOR_TOKEN,
  TEXT_TOKEN,
  type Bitmap,
} from '~/utils/intrusion/sprites'
import { fitText } from '~/utils/intrusion/text'

const props = withDefaults(
  defineProps<{
    status: string
    startedAt?: string | null
    engines?: Engine[]
    engineRuns?: EngineRunView[]
    progress?: EngineProgressView | null
    serverNow?: string | null
    /** Shown under the target; falls back to "Target". */
    targetName?: string | null
  }>(),
  {
    startedAt: null,
    engines: () => [],
    engineRuns: () => [],
    progress: null,
    serverNow: null,
    targetName: null,
  },
)

const { now } = useServerClock(toRef(props, 'serverNow'))

const hud = computed(() =>
  deriveIntrusionHud({
    status: props.status,
    engines: props.engines,
    engineRuns: props.engineRuns,
    progress: props.progress,
    now: now.value,
  }),
)
const activeEngine = computed(() =>
  hud.value.active >= 0 ? hud.value.lanes[hud.value.active]!.engine : null,
)
const engineLabel = computed(() =>
  activeEngine.value ? ENGINE_SHORT_LABELS[activeEngine.value] : 'Standby',
)
const elapsed = computed(() =>
  hud.value.outcome || props.status === 'queued' ? null : formatElapsed(props.startedAt, now.value),
)
// The attacking engine's current phase, only while it is the one attacking.
const stage = computed(() =>
  !hud.value.outcome && props.progress && props.progress.engine === activeEngine.value
    ? props.progress.stage
    : null,
)
const outcomeText = computed(() =>
  hud.value.outcome === 'complete'
    ? 'Scan complete'
    : hud.value.outcome === 'lost'
      ? 'Connection lost'
      : null,
)

// The simulation is deliberately not reactive: it mutates every frame and
// Vue tracking it would cost more than the animation itself.
const sim = createSim()
// Only flips when the banner appears/disappears, not per frame.
const bannerOn = ref(false)
/** Exposed for tests and for the curious: whether a frame loop is scheduled. */
const looping = ref(false)

const wrapper = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let rafId = 0
let mounted = false
let lastTs = 0
let accMs = 0
let reducedMotion = false
let resizeObserver: ResizeObserver | null = null
let motionQuery: MediaQueryList | null = null
const FRAME_MS = 1000 / 30

// --- colors & sprites ----------------------------------------------------------
const colors = new Map<string, string>()
function color(tokenName: string): string {
  let c = colors.get(tokenName)
  if (c === undefined) {
    c = getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim()
    colors.set(tokenName, c)
  }
  return c
}

const sprites = new Map<string, HTMLCanvasElement>()
function sprite(bitmap: Bitmap, colorToken: string): HTMLCanvasElement | null {
  const key = `${colorToken}|${bitmap.join('/')}`
  const cached = sprites.get(key)
  if (cached) return cached
  const c = document.createElement('canvas')
  c.width = bitmap[0]!.length
  c.height = bitmap.length
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = color(colorToken)
  bitmap.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') g.fillRect(x, y, 1, 1)
  })
  sprites.set(key, c)
  return c
}

function blit(s: HTMLCanvasElement | null, x: number, y: number, scale: number): void {
  if (s && ctx) ctx.drawImage(s, Math.round(x), Math.round(y), s.width * scale, s.height * scale)
}

// --- drawing ---------------------------------------------------------------
// Canvas fonts can't read CSS variables; resolved once on mount.
let displayFont = 'sans-serif'
let monoFont = 'monospace'

function laneNote(lane: Lane, i: number): string {
  switch (lane.state) {
    case 'done':
      return `✓ ${lane.findings} vuln`
    case 'failed':
      return '✗ failed'
    case 'skipped':
      return 'skipped'
    case 'running':
      return i === sim.active && sim.stage ? sim.stage : 'running'
    case 'queued':
      return 'queued'
  }
}

function logColor(kind: LogKind, engine: Engine | null): string {
  switch (kind) {
    case 'launch':
      return color(engine ? ENGINE_COLOR_TOKENS[engine] : TERMINAL_COLOR_TOKEN)
    case 'hit':
      return color(HIT_COLOR_TOKEN)
    case 'fail':
      return color(FAIL_COLOR_TOKEN)
    case 'stage':
    case 'ok':
      return color(TERMINAL_COLOR_TOKEN)
  }
}

function drawLanes(g: CanvasRenderingContext2D, lanes: Lane[]): void {
  const n = lanes.length
  lanes.forEach((lane, i) => {
    const { y, h } = laneBox(i, n)
    const attacking = i === sim.active && !sim.outcome && lane.state === 'running'
    const lostHere = sim.outcome === 'lost' && i === sim.active
    const waiting = lane.state === 'queued'
    const tokenName = lostHere
      ? FAIL_COLOR_TOKEN
      : waiting
        ? QUEUED_COLOR_TOKEN
        : ENGINE_COLOR_TOKENS[lane.engine]
    const finished = !waiting && !attacking && !lostHere
    g.globalAlpha = finished ? 0.55 : attacking ? 0.55 + 0.45 * Math.sin(sim.timeMs / 160) : 1
    g.strokeStyle = color(tokenName)
    if (waiting) g.setLineDash([2, 2])
    g.strokeRect(LANE_X + 0.5, y + 0.5, LANE_W, h)
    g.setLineDash([])
    g.globalAlpha = finished ? 0.55 : 1
    const iconScale = h >= 22 ? 2 : 1.5
    blit(
      sprite(ENGINE_ICONS[lane.engine], tokenName),
      LANE_X + 5,
      y + (h - 7 * iconScale) / 2,
      iconScale,
    )
    g.fillStyle = color(waiting ? MUTED_TEXT_TOKEN : TEXT_TOKEN)
    g.font = `${h >= 22 ? 9 : 8}px ${displayFont}`
    g.fillText(ENGINE_SHORT_LABELS[lane.engine].toUpperCase(), LANE_X + 22, y + h * 0.2)
    g.fillStyle = color(waiting ? QUEUED_COLOR_TOKEN : tokenName)
    g.font = `7px ${monoFont}`
    g.fillText(laneNote(lane, i), LANE_X + 22, y + h * 0.58)
  })
  g.globalAlpha = 1
}

function drawLink(g: CanvasRenderingContext2D): void {
  if (sim.active < 0 || sim.outcome || sim.active >= sim.laneCount) return
  const { y, h } = laneBox(sim.active, sim.laneCount)
  const engine = hud.value.lanes[sim.active]?.engine
  if (!engine) return
  const x0 = LANE_X + LANE_W + 2
  const x1 = TARGET_X - shieldRadius(sim)
  const y0 = y + h / 2
  g.strokeStyle = color(ENGINE_COLOR_TOKENS[engine])
  g.globalAlpha = 0.25
  g.setLineDash([3, 4])
  g.lineDashOffset = -sim.timeMs / 30
  g.beginPath()
  g.moveTo(x0, y0)
  g.lineTo(x1, TARGET_Y)
  g.stroke()
  g.setLineDash([])
  g.globalAlpha = 1

  g.fillStyle = color(ENGINE_COLOR_TOKENS[engine])
  for (const p of sim.packets) {
    if (!p.active) continue
    const { y: py, h: ph } = laneBox(p.lane, sim.laneCount)
    const from = py + ph / 2
    const px = x0 + (x1 - x0) * p.t
    const pyy = from + (TARGET_Y - from) * p.t + Math.sin(p.t * 9 + p.wobble) * 3 * (1 - p.t)
    g.fillRect(px, pyy, 3, 1)
    g.globalAlpha = 0.4
    g.fillRect(px - 4, pyy, 4, 1)
    g.globalAlpha = 1
  }
}

// The label must fit the space right of the link, so long site names are
// cut with an ellipsis. Measured once per name, not per frame.
const TARGET_LABEL_MAX_W = (SIM_W - TARGET_X - 4) * 2
let targetLabelFor: string | null = null
let targetLabelText = ''
function targetLabel(g: CanvasRenderingContext2D): string {
  const name = (props.targetName?.trim() || 'Target').toUpperCase()
  if (name === targetLabelFor) return targetLabelText
  targetLabelFor = name
  targetLabelText = fitText(name, TARGET_LABEL_MAX_W, (t) => g.measureText(t).width)
  return targetLabelText
}

function drawTarget(g: CanvasRenderingContext2D): void {
  g.strokeStyle = color(SHIELD_COLOR_TOKEN)
  g.lineWidth = 2
  let k = 0
  RINGS.forEach((ring, ri) => {
    for (let j = 0; j < ring.segments; j++, k++) {
      if (sim.broken[k]) continue
      const a0 = (j / ring.segments) * Math.PI * 2 + 0.08
      const a1 = ((j + 1) / ring.segments) * Math.PI * 2 - 0.08
      const core = ri === RINGS.length - 1
      g.globalAlpha = (core ? 0.75 : 0.45) + 0.25 * Math.sin(sim.timeMs / 300 + j)
      g.beginPath()
      g.ellipse(TARGET_X, TARGET_Y, ring.r, ring.r * RING_SQUASH, 0, a0, a1)
      g.stroke()
    }
  })
  g.globalAlpha = 1
  g.lineWidth = 1

  const serverToken =
    sim.flashMs > 0
      ? HIT_COLOR_TOKEN
      : sim.outcome === 'lost'
        ? QUEUED_COLOR_TOKEN
        : SERVER_COLOR_TOKEN
  blit(sprite(SERVER, serverToken), TARGET_X - 10, TARGET_Y - 13, 2)
  if (sim.active >= 0 && !sim.outcome) {
    // Activity LEDs blink while under attack.
    g.fillStyle = color(TERMINAL_COLOR_TOKEN)
    g.globalAlpha = Math.sin(sim.timeMs / 90) > 0 ? 1 : 0.2
    g.fillRect(TARGET_X + 4, TARGET_Y - 9, 2, 2)
    g.fillRect(TARGET_X + 4, TARGET_Y - 1, 2, 2)
    g.globalAlpha = 1
  }
  g.fillStyle = color(MUTED_TEXT_TOKEN)
  g.font = `8px ${displayFont}`
  g.textAlign = 'center'
  g.fillText(targetLabel(g), TARGET_X, TARGET_Y + 46)
  g.textAlign = 'left'
}

function drawEffects(g: CanvasRenderingContext2D): void {
  for (const sp of sim.sparks) {
    if (!sp.active) continue
    g.globalAlpha = 1 - sp.ageMs / SPARK_MS
    g.fillStyle = color(sp.hit ? HIT_COLOR_TOKEN : TEXT_TOKEN)
    g.fillRect(sp.x, sp.y, 1.5, 1.5)
  }
  g.fillStyle = color(HIT_COLOR_TOKEN)
  g.font = `9px ${displayFont}`
  for (const p of sim.pops) {
    if (!p.active) continue
    g.globalAlpha = 1 - p.ageMs / POP_MS
    g.fillText('+1 VULN', p.x - 14, TARGET_Y - 30 - p.ageMs / 60)
  }
  g.globalAlpha = 1
}

function drawTerminal(g: CanvasRenderingContext2D): void {
  g.fillStyle = color(TERMINAL_COLOR_TOKEN)
  g.globalAlpha = 0.08
  g.fillRect(0, SIM_H - 28, SIM_W, 28)
  g.globalAlpha = 1
  g.font = `7px ${monoFont}`
  sim.logs.forEach((line, i) => {
    g.fillStyle = logColor(line.kind, line.engine)
    g.fillText(line.text, 6, SIM_H - 26 + i * 8)
  })
}

function drawProgressBar(g: CanvasRenderingContext2D): void {
  const y = SIM_H - 36
  g.fillStyle = color(QUEUED_COLOR_TOKEN)
  g.fillRect(LANE_X, y, LANE_W, 2)
  const engine = activeEngine.value
  g.fillStyle = color(
    sim.outcome === 'lost'
      ? FAIL_COLOR_TOKEN
      : engine
        ? ENGINE_COLOR_TOKENS[engine]
        : QUEUED_COLOR_TOKEN,
  )
  g.fillRect(LANE_X, y, LANE_W * (sim.outcome === 'complete' ? 1 : hud.value.progress), 2)
}

function draw(): void {
  if (!ctx || !canvas.value) return
  const g = ctx
  const k = canvas.value.width / SIM_W
  g.setTransform(k, 0, 0, k, 0, 0)
  g.imageSmoothingEnabled = false
  g.textBaseline = 'top'
  g.clearRect(0, 0, SIM_W, SIM_H)

  // Faint grid.
  g.fillStyle = color(TERMINAL_COLOR_TOKEN)
  g.globalAlpha = 0.07
  for (let x = 0; x < SIM_W; x += 16) g.fillRect(x, 0, 1, SIM_H)
  for (let y = 0; y < SIM_H; y += 16) g.fillRect(0, y, SIM_W, 1)
  g.globalAlpha = 1

  drawLanes(g, hud.value.lanes)
  drawLink(g)
  drawTarget(g)
  drawEffects(g)
  drawProgressBar(g)
  drawTerminal(g)

  // Scanlines, plus static noise once the connection is lost.
  g.fillStyle = '#000'
  g.globalAlpha = 0.25
  for (let y = 0; y < SIM_H; y += 2) g.fillRect(0, y, SIM_W, 1)
  if (sim.outcome === 'lost') {
    g.fillStyle = color(FAIL_COLOR_TOKEN)
    for (let i = 0; i < 6; i++) {
      g.globalAlpha = Math.random() * 0.25
      g.fillRect(0, Math.random() * SIM_H, SIM_W, 1 + Math.random() * 3)
    }
  }
  g.globalAlpha = 1
}

// --- frame loop --------------------------------------------------------------
function frame(ts: number): void {
  rafId = 0
  // Clamp: a long gap (tab throttled) must not teleport the simulation.
  accMs += Math.min(ts - lastTs, 100)
  lastTs = ts
  if (accMs >= FRAME_MS) {
    stepSim(sim, accMs)
    accMs = 0
    draw()
    const banner = bannerVisible(sim)
    if (banner !== bannerOn.value) bannerOn.value = banner
  }
  if (isSettled(sim)) stopLoop()
  else schedule()
}

function schedule(): void {
  rafId = requestAnimationFrame(frame)
  looping.value = true
}

function startLoop(): void {
  if (!mounted || rafId || reducedMotion || document.hidden || isSettled(sim)) return
  lastTs = performance.now()
  accMs = 0
  schedule()
}

function stopLoop(): void {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  looping.value = false
}

function onVisibility(): void {
  if (document.hidden) stopLoop()
  else startLoop()
}

function onMotionChange(): void {
  reducedMotion = motionQuery?.matches ?? false
  if (reducedMotion) {
    stopLoop()
    settleSim(sim)
    draw()
  } else startLoop()
}

function resize(): void {
  const el = canvas.value
  if (!el || !wrapper.value) return
  const cssW = wrapper.value.clientWidth || SIM_W
  const w = Math.max(SIM_W, Math.round(cssW * (window.devicePixelRatio || 1)))
  el.width = w
  el.height = Math.round((w * SIM_H) / SIM_W)
  draw()
}

function sync(): void {
  syncSim(sim, hud.value, stage.value)
  if (reducedMotion) {
    settleSim(sim)
    draw()
  } else startLoop()
}

// Side effects only once mounted: setup also runs during SSR, where there is
// no canvas and no requestAnimationFrame.
watch([hud, stage], () => {
  if (mounted) sync()
})

onMounted(() => {
  ctx = canvas.value?.getContext('2d') ?? null
  mounted = true
  displayFont = color('--font-display') || 'sans-serif'
  monoFont = color('--font-mono') || 'monospace'
  motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  reducedMotion = motionQuery?.matches ?? false
  motionQuery?.addEventListener('change', onMotionChange)
  document.addEventListener('visibilitychange', onVisibility)
  if (typeof ResizeObserver !== 'undefined' && wrapper.value) {
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(wrapper.value)
  }
  resize()
  sync()
  draw()
})

onUnmounted(() => {
  mounted = false
  stopLoop()
  document.removeEventListener('visibilitychange', onVisibility)
  motionQuery?.removeEventListener('change', onMotionChange)
  resizeObserver?.disconnect()
  sprites.clear()
  colors.clear()
})
</script>

<template>
  <div
    ref="wrapper"
    data-testid="intrusion"
    :data-looping="looping"
    :data-phase="hud.phase"
    :data-outcome="hud.outcome ?? ''"
    class="relative mx-auto w-full max-w-[640px] overflow-hidden bg-ink text-on-primary"
  >
    <canvas
      ref="canvas"
      aria-hidden="true"
      class="block aspect-[2/1] w-full [image-rendering:pixelated]"
    />
    <div
      class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 px-sm py-xs text-caption-sm uppercase"
    >
      <span>
        <span data-testid="intrusion-engine" class="font-display">{{ engineLabel }}</span>
        <span v-if="stage" data-testid="intrusion-stage" class="ml-xs normal-case text-stone">{{
          stage
        }}</span>
      </span>
      <span class="font-display">
        <span data-testid="intrusion-phase">Phase {{ hud.phase }}/{{ hud.lanes.length }}</span>
        · <span data-testid="intrusion-vulns">Vuln {{ hud.findings }}</span>
        <template v-if="elapsed">
          · <span data-testid="intrusion-elapsed">{{ elapsed }}</span>
        </template>
      </span>
    </div>
    <p
      v-if="bannerOn && activeEngine && !outcomeText"
      data-testid="intrusion-banner"
      class="font-display absolute inset-x-0 top-[42%] text-center text-heading-lg uppercase"
      :style="{ color: `var(${ENGINE_COLOR_TOKENS[activeEngine]})` }"
    >
      Phase {{ hud.phase }} // {{ ENGINE_SHORT_LABELS[activeEngine] }}
    </p>
    <p
      v-if="outcomeText"
      data-testid="intrusion-outcome"
      role="status"
      class="font-display absolute inset-x-0 top-[38%] text-center text-heading-xl uppercase"
      :class="hud.outcome === 'complete' ? 'text-success-bright' : 'text-sale'"
    >
      {{ outcomeText }}
    </p>
  </div>
</template>
