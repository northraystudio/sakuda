<script setup lang="ts">
import ScanStatusBadge from '~/components/scan/ScanStatusBadge.vue'
import SeverityStackChart from '~/components/chart/SeverityStackChart.vue'
import EngineCountChart from '~/components/chart/EngineCountChart.vue'
import DiffTrendChart from '~/components/chart/DiffTrendChart.vue'
import type {
  Engine,
  EngineTargets,
  HistoryPoint,
  ScanSummary,
  SitePublic,
  TargetRef,
  TargetSummary,
} from '#shared/types/api'
import { parseNucleiPathLines } from '#shared/utils/nucleiPaths'
import { isActiveScanEnabled } from '#shared/utils/activeScan'
import { ENGINE_LABELS, ENGINE_ORDER } from '#shared/utils/engines'
import { formatTargetLine } from '#shared/utils/targetLines'
import { findExpiryProblems, formatExpiryWarning } from '#shared/utils/secretExpiry'

const route = useRoute()
// `route.params.id` is `string | string[]` generically; this route only has
// a single `[id]` segment, so it is always a plain string at runtime.
const rawSiteId = route.params.id
const siteId = Array.isArray(rawSiteId) ? (rawSiteId[0] ?? '') : rawSiteId

const { data: site, error: siteError } = await useFetch<SitePublic>(`/api/sites/${siteId}`)
const { data: scans } = await useFetch<ScanSummary[]>(`/api/sites/${siteId}/scans`)
const { data: history } = await useFetch<HistoryPoint[]>(`/api/sites/${siteId}/history`)
// Read-only: the saved list and what each engine will do with it. Editing
// (discovery, save, remove) lives on the Edit page.
const { data: targetSummary } = await useFetch<TargetSummary>(`/api/sites/${siteId}/targets`)

const nucleiChecked = ref(true)
const zapApiChecked = ref(false)
const zapFeChecked = ref(true)
const dalfoxChecked = ref(false)

const submitting = ref(false)
const errorMessage = ref<string | null>(null)

// nuclei always runs: with no paths configured it scans the base URL(s).
const nucleiAvailable = computed(() => !!site.value)
const savedTargetCount = computed(() =>
  site.value ? parseNucleiPathLines(site.value.nucleiPaths).lines.length : 0,
)
const nucleiScansRootOnly = computed(() => !!site.value && savedTargetCount.value === 0)

const lineOf = (t: TargetRef) => formatTargetLine(t.method, t.base, t.path)
const engineRows = computed(() =>
  ENGINE_ORDER.map((engine) => ({
    engine,
    label: ENGINE_LABELS[engine],
    view: targetSummary.value?.engines[engine] ?? null,
  })),
)
/** One line per engine on why lines are left alone or where they come from —
 * the rule the engine adapter applies, stated for the reader. */
function engineNote(engine: Engine, view: EngineTargets): string {
  const summary = targetSummary.value
  if (!summary) return ''
  switch (engine) {
    case 'nuclei':
      return summary.configured
        ? 'Server-side: hash routes are left to the ZAP frontend DOM probe; non-GET lines are replayed only under active checks.'
        : 'No target paths saved — scans the base URL root(s) only.'
    case 'zap-fe':
      return 'Requests the front-base lines before its spiders run; hash routes are opened in a browser (DOM XSS probe) and mutating methods are sent only under active checks.'
    case 'zap-api':
      return {
        none: 'No OpenAPI URL or JSON, and no non-GET line to build one from under active checks.',
        openapi: 'Operations come from the OpenAPI document; saved lines are not used.',
        generated: 'Operations are generated from the non-GET lines (active checks).',
        'openapi+generated': 'OpenAPI document plus a generated one from the non-GET lines.',
      }[summary.zapApiSource]
    case 'dalfox':
      return view.available
        ? 'GET lines the server can reach; hash routes belong to the DOM probe.'
        : 'Runs only under active checks.'
  }
}
// dalfox sends attack payloads, so it can run only under active injection checks.
const dalfoxAvailable = computed(() => !!site.value && isActiveScanEnabled(site.value))
const zapApiAvailable = computed(
  () => !!site.value && (!!site.value.openapiUrl || !!site.value.openapiJson),
)

const canStartScan = computed(
  () =>
    !submitting.value &&
    (nucleiChecked.value || zapApiChecked.value || zapFeChecked.value || dalfoxChecked.value),
)

function selectedEngines(): Engine[] {
  const engines: Engine[] = []
  if (nucleiChecked.value) engines.push('nuclei')
  if (zapApiChecked.value) engines.push('zap-api')
  if (zapFeChecked.value) engines.push('zap-fe')
  if (dalfoxChecked.value) engines.push('dalfox')
  return engines
}

/** Expired / soon-expiring auth secrets (#17), shown before Start scan so a
 * logged-out run is not misread. Evaluated against the time of render. */
const authExpiryWarnings = computed(() =>
  findExpiryProblems(site.value?.secretExpiries ?? {}, new Date()).map(formatExpiryWarning),
)

async function handleStartScan() {
  if (!canStartScan.value) return
  submitting.value = true
  errorMessage.value = null
  try {
    const scan = await $fetch<ScanSummary>(`/api/sites/${siteId}/scans`, {
      method: 'POST',
      body: { engines: selectedEngines() },
    })
    await navigateTo(`/scans/${scan.id}`)
  } catch (err) {
    errorMessage.value = toApiErrorMessage(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div>
    <p v-if="siteError" class="text-sale text-body-md">{{ toApiErrorMessage(siteError) }}</p>

    <template v-else-if="site">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="font-display text-heading-xl uppercase">{{ site.name }}</h1>
          <p class="text-caption-md text-mute">{{ site.frontBaseUrl }}</p>
          <p v-if="site.apiBaseUrl" class="text-caption-md text-mute">{{ site.apiBaseUrl }}</p>
        </div>
        <NuxtLink :to="`/sites/${siteId}/edit`" class="btn-secondary">Edit</NuxtLink>
      </div>

      <section class="mt-6">
        <h2 class="font-display text-heading-md uppercase">History</h2>
        <div class="mt-2 grid gap-6 md:grid-cols-3">
          <SeverityStackChart :history="history ?? []" />
          <EngineCountChart :history="history ?? []" />
          <DiffTrendChart :history="history ?? []" />
        </div>
      </section>

      <section class="card mt-6 flex flex-col gap-4" data-testid="targets-section">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="font-display text-heading-md uppercase">Targets</h2>
          <p class="text-caption-md text-mute" data-testid="saved-target-count">
            {{ savedTargetCount }} saved target path{{ savedTargetCount === 1 ? '' : 's' }}
            <NuxtLink :to="`/sites/${siteId}/edit`" class="text-ink ml-2 underline">Edit</NuxtLink>
          </p>
        </div>
        <p class="text-caption-sm text-mute">
          One saved list, read by every engine. Discover URLs, review and save or remove them in
          Edit — you only need to discover again when the site changes.
        </p>

        <template v-if="targetSummary">
          <p
            v-if="!targetSummary.configured"
            class="text-caption-md text-mute"
            data-testid="no-common-targets"
          >
            Nothing saved yet — nuclei falls back to the base URL root(s); the other engines work
            from their own crawl or OpenAPI document.
          </p>
          <details v-else class="text-caption-md" data-testid="common-targets-details">
            <summary class="cursor-pointer">
              {{ targetSummary.common.length }} saved line{{
                targetSummary.common.length === 1 ? '' : 's'
              }}
            </summary>
            <ul class="mt-1 flex flex-col gap-1 font-mono" data-testid="common-targets">
              <li v-for="t in targetSummary.common" :key="lineOf(t)" class="break-all">
                {{ lineOf(t) }}
              </li>
            </ul>
          </details>
          <p
            v-if="targetSummary.excludedCount > 0"
            class="text-caption-sm text-mute"
            data-testid="excluded-target-count"
          >
            {{ targetSummary.excludedCount }} line{{ targetSummary.excludedCount === 1 ? '' : 's' }}
            dropped by Exclude paths.
          </p>

          <div class="overflow-x-auto">
            <table class="text-caption-md w-full" data-testid="engine-targets">
              <thead>
                <tr class="text-mute text-left">
                  <th class="pb-2 pr-4">Engine</th>
                  <th class="pb-2 pr-4 whitespace-nowrap">Targets</th>
                  <th class="pb-2 pr-4 whitespace-nowrap">Left alone</th>
                  <th class="pb-2">How it uses the list</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in engineRows"
                  :key="row.engine"
                  class="border-hairline-soft border-t align-top"
                  :data-testid="`engine-targets-${row.engine}`"
                >
                  <td class="py-2 pr-4 whitespace-nowrap">
                    {{ row.label }}
                    <span v-if="row.view && !row.view.available" class="badge text-mute ml-2"
                      >unavailable</span
                    >
                  </td>
                  <td class="py-2 pr-4">
                    <details v-if="row.view && row.view.targets.length > 0">
                      <summary class="cursor-pointer">{{ row.view.targets.length }}</summary>
                      <ul class="mt-1 font-mono">
                        <li v-for="t in row.view.targets" :key="lineOf(t)" class="break-all">
                          {{ lineOf(t) }}
                        </li>
                      </ul>
                    </details>
                    <template v-else>0</template>
                  </td>
                  <td class="py-2 pr-4">
                    <details v-if="row.view && row.view.skipped.length > 0">
                      <summary class="cursor-pointer">{{ row.view.skipped.length }}</summary>
                      <ul class="mt-1 font-mono">
                        <li v-for="t in row.view.skipped" :key="lineOf(t)" class="break-all">
                          {{ lineOf(t) }}
                        </li>
                      </ul>
                    </details>
                    <template v-else>0</template>
                  </td>
                  <td class="text-mute py-2">
                    {{ row.view ? engineNote(row.engine, row.view) : '' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <section class="card mt-6 flex flex-col gap-4">
        <h2 class="font-display text-heading-md uppercase">Start scan</h2>

        <div class="flex flex-col gap-3">
          <div>
            <label class="text-body-md text-ink flex items-center gap-2">
              <input
                v-model="nucleiChecked"
                data-testid="engine-nuclei"
                type="checkbox"
                :disabled="!nucleiAvailable"
              />
              {{ ENGINE_LABELS.nuclei }}
            </label>
            <p v-if="nucleiScansRootOnly" class="text-caption-sm text-mute mt-1">
              No target paths saved — nuclei scans the base URL only. Discover URLs or add paths in
              Edit to cover more pages/endpoints.
            </p>
          </div>

          <div>
            <label class="text-body-md text-ink flex items-center gap-2">
              <input
                v-model="zapApiChecked"
                data-testid="engine-zap-api"
                type="checkbox"
                :disabled="!zapApiAvailable"
              />
              {{ ENGINE_LABELS['zap-api'] }}
            </label>
            <p v-if="!zapApiAvailable" class="text-caption-sm text-mute mt-1">
              Add an OpenAPI URL or JSON in Edit to enable this engine.
            </p>
          </div>

          <label class="text-body-md text-ink flex items-center gap-2">
            <input v-model="zapFeChecked" data-testid="engine-zap-fe" type="checkbox" />
            {{ ENGINE_LABELS['zap-fe'] }}
          </label>

          <div>
            <label class="text-body-md text-ink flex items-center gap-2">
              <input
                v-model="dalfoxChecked"
                data-testid="engine-dalfox"
                type="checkbox"
                :disabled="!dalfoxAvailable"
              />
              {{ ENGINE_LABELS.dalfox }}
            </label>
            <p v-if="!dalfoxAvailable" class="text-caption-sm text-mute mt-1">
              Turn on "Active injection checks" in Edit to enable this XSS engine.
            </p>
          </div>
        </div>

        <ul v-if="authExpiryWarnings.length > 0" class="flex flex-col gap-2">
          <li
            v-for="(warning, index) in authExpiryWarnings"
            :key="index"
            data-testid="auth-expiry-warning"
            class="border-sale bg-soft-cloud text-caption-md text-ink border-l-4 px-4 py-2"
          >
            {{ warning }}
          </li>
        </ul>

        <p v-if="errorMessage" data-testid="scan-error" class="text-sale text-body-md">
          {{ errorMessage }}
        </p>

        <button
          type="button"
          data-testid="start-scan"
          class="btn-primary self-start"
          :disabled="!canStartScan"
          @click="handleStartScan"
        >
          Start scan
        </button>
      </section>

      <section class="mt-6">
        <h2 class="font-display text-heading-md uppercase">Scans</h2>

        <p v-if="!scans || scans.length === 0" class="text-caption-md text-mute mt-2">
          No scans yet.
        </p>

        <div v-else class="mt-2 overflow-x-auto">
          <table class="text-caption-md w-full">
            <thead>
              <tr class="text-mute text-left">
                <th class="pb-2">Status</th>
                <th class="pb-2">Engines</th>
                <th class="pb-2">Created</th>
                <th class="pb-2">Findings</th>
                <th class="pb-2" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="scan in scans" :key="scan.id" class="border-hairline-soft border-t">
                <td class="py-2"><ScanStatusBadge :status="scan.status" /></td>
                <td class="py-2">{{ scan.engines.join(', ') }}</td>
                <td class="py-2">{{ scan.createdAt.slice(0, 10) }}</td>
                <td class="py-2">{{ reportedTotal(scan.counts) }}</td>
                <td class="py-2">
                  <NuxtLink :to="`/scans/${scan.id}`" class="text-body-md text-ink underline">
                    View
                  </NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
