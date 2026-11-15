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
    <span v-if="authLost.hint === 'blocked-before-app'" data-testid="auth-lost-hint">
      The answer was a block page from something in front of the app (a dev server's host check such
      as Vite allowedHosts, a proxy or a WAF), so the login itself may be fine — the scan's requests
      are likely blocked too. Allow the host sakuda uses there (host.docker.internal when the target
      runs on localhost) and scan again.
    </span>
    <span v-else>
      Results after this point may be from a logged-out session — stop the scan, refresh the site's
      auth headers and scan again.
    </span>
  </div>
</template>
