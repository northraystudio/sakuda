<script setup lang="ts">
import type { ScanAuthLost } from '#shared/types/api'

/** Shown when the scan's login check saw a 401/403 (#74): results from that
 * point on may come from a logged-out session. */
const props = defineProps<{ authLost: ScanAuthLost }>()

const detectedAt = computed(() => new Date(props.authLost.detectedAt).toLocaleString())
</script>

<template>
  <div
    data-testid="auth-lost-notice"
    role="alert"
    class="border-sale bg-soft-cloud text-caption-md text-ink border-l-4 px-4 py-2"
  >
    Login stopped working at {{ detectedAt }}: {{ authLost.path }} answered {{ authLost.status }}.
    Results after this point may be from a logged-out session — stop the scan, refresh the site's
    auth headers and scan again.
  </div>
</template>
