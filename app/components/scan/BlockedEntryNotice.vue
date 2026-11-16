<script setup lang="ts">
import type { ScanBlockedBeforeApp, ScanEntry } from '#shared/types/api'

/** Shown when the scan-start entry check (#82) got a block page of something
 * in front of the target: every engine request goes to the same entry, so
 * the results are likely empty rather than clean. */
const props = defineProps<{
  blocked: ScanBlockedBeforeApp
  frontBaseUrl: string
  apiBaseUrl: string | null
}>()

const ENTRY_LABEL: Record<ScanEntry, string> = { front: 'Front', api: 'API' }

const entries = computed(() =>
  props.blocked.entries.map((e) => ({
    key: e.entry,
    label: ENTRY_LABEL[e.entry],
    url: e.entry === 'front' ? props.frontBaseUrl : props.apiBaseUrl,
    status: e.status,
  })),
)
</script>

<template>
  <div
    data-testid="blocked-entry-notice"
    role="alert"
    class="border-sale bg-soft-cloud text-caption-md text-ink border-l-4 px-4 py-2"
  >
    <p>
      sakuda's requests are being blocked before they reach the app — a few results, or none, may
      mean the scan never got in, not that the site is clean:
    </p>
    <ul class="my-1 list-disc pl-5">
      <li v-for="e in entries" :key="e.key" :data-testid="`blocked-entry-${e.key}`">
        {{ e.label }} <span class="text-mute">{{ e.url }}</span> answered {{ e.status }} with a
        block page
      </li>
    </ul>
    <p>
      Something in front of the app (a dev server's host check such as Vite allowedHosts, a proxy or
      a WAF) refused the host sakuda uses. Allow it there (host.docker.internal when the target runs
      on localhost), then stop this scan and scan again.
    </p>
  </div>
</template>
