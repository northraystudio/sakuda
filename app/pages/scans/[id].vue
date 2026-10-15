<script setup lang="ts">
import DiffSummary from '~/components/scan/DiffSummary.vue'
import EngineRunPanel from '~/components/scan/EngineRunPanel.vue'
import IntrusionProgress from '~/components/scan/IntrusionProgress.vue'
import ScanProgress from '~/components/scan/ScanProgress.vue'
import ScanStatusBadge from '~/components/scan/ScanStatusBadge.vue'
import SeverityCountCards from '~/components/scan/SeverityCountCards.vue'
import { finaleFor, type IntrusionOutcome } from '~/utils/intrusion/hud'

const route = useRoute()
// `route.params.id` is generically `string | string[] | undefined`; this
// route only has a single `[id]` segment, so it is always a plain string at
// runtime — the `?? ''` fallbacks are type-safety only.
const rawScanId = route.params.id
const scanId = Array.isArray(rawScanId) ? (rawScanId[0] ?? '') : (rawScanId ?? '')

const { state, error, start } = useScanPolling(scanId)

// The header site switcher reads the active site from a shared state; the
// scan route has no siteId in its path, so publish it once the scan loads.
const activeSiteId = useActiveSiteId()
watch(
  () => state.value?.siteId ?? null,
  (id) => {
    activeSiteId.value = id
  },
  { immediate: true },
)

// Live engine progress drives the visualizer between scan polls; it only
// runs while the scan does.
const progressPoll = useScanProgressPolling(scanId)
let progressStarted = false
watch(
  () => state.value?.status,
  (status) => {
    if (status === 'running' && !progressStarted) {
      progressStarted = true
      progressPoll.start()
    } else if (status === 'done' || status === 'failed') progressPoll.stop()
  },
)

// SCAN COMPLETE / CONNECTION LOST plays only for a finish seen on this page, above the report.
const finale = ref<IntrusionOutcome | null>(null)
watch(
  () => state.value?.status,
  (next, prev) => {
    const f = finaleFor(prev, next)
    if (f) finale.value = f
  },
)

onMounted(() => {
  start()
})

// Treated as "still in progress" until the first poll response arrives, or
// while the scan is queued/running — everything else (done, failed) is
// rendered as the finished report view below.
const isActive = computed(() => {
  const status = state.value?.status
  return !state.value || status === 'queued' || status === 'running'
})

const totalCounts = computed(() => {
  if (!state.value) return emptyCounts()
  return state.value.engineRuns.reduce((acc, run) => addCounts(acc, run.counts), emptyCounts())
})
</script>

<template>
  <div>
    <p v-if="error" data-testid="poll-error" class="text-sale text-body-md">{{ error }}</p>

    <ScanProgress
      v-else-if="isActive"
      :status="state?.status ?? 'queued'"
      :started-at="state?.startedAt"
      :engines="state?.engines ?? []"
      :engine-runs="state?.engineRuns ?? []"
      :server-now="state?.now ?? null"
      :site-name="state?.siteName ?? null"
      :progress="progressPoll.state.value?.progress ?? null"
      :progress-unavailable="progressPoll.error.value !== null"
    />

    <template v-else-if="state">
      <div v-if="finale" data-testid="scan-finale" class="mb-6">
        <IntrusionProgress
          :status="state.status"
          :started-at="state.startedAt"
          :engines="state.engines"
          :engine-runs="state.engineRuns"
          :server-now="state.now"
          :target-name="state.siteName"
        />
        <div class="mt-2 flex justify-center">
          <button type="button" class="btn-secondary" @click="finale = null">Close</button>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-4">
        <h1 class="font-display text-heading-xl uppercase">Scan report</h1>
        <ScanStatusBadge :status="state.status" />
      </div>

      <p v-if="state.error" class="text-sale text-body-md mt-2">{{ state.error }}</p>

      <SeverityCountCards class="mt-6" :counts="totalCounts" />

      <DiffSummary class="mt-6" :diff="state.diff" />

      <div class="mt-6 flex flex-wrap items-center gap-4">
        <a :href="`/api/scans/${scanId}/report.md`" class="btn-secondary">Download Markdown</a>
        <NuxtLink :to="`/sites/${state.siteId}`" class="text-body-md text-ink underline">
          Back to site
        </NuxtLink>
      </div>

      <div class="mt-6 flex flex-col gap-6">
        <EngineRunPanel
          v-for="run in state.engineRuns"
          :key="run.id"
          :run="run"
          :findings="state.findings"
          :server-now="state.now"
        />
      </div>
    </template>
  </div>
</template>
