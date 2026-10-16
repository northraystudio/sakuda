<script setup lang="ts">
import type { ScanDiff } from '#shared/types/api'

defineProps<{ diff: ScanDiff | null }>()
</script>

<template>
  <section class="card" data-testid="diff-summary">
    <h2 class="font-display text-heading-md uppercase">Changes vs previous scan</h2>

    <p v-if="!diff" data-testid="diff-no-previous" class="mt-2 text-caption-md text-mute">
      No previous scan.
    </p>

    <template v-else>
      <dl class="mt-2 flex flex-wrap gap-6">
        <div>
          <dt class="text-caption-sm text-mute">New</dt>
          <dd data-testid="diff-new" class="text-heading-md text-ink">{{ diff.newCount }}</dd>
        </div>
        <div>
          <dt class="text-caption-sm text-mute">Persisting</dt>
          <dd data-testid="diff-persisting" class="text-heading-md text-ink">
            {{ diff.persistingCount }}
          </dd>
        </div>
        <div v-if="diff.suppressedCount > 0">
          <dt class="text-caption-sm text-mute">Not new (triaged)</dt>
          <dd data-testid="diff-suppressed" class="text-heading-md text-mute">
            {{ diff.suppressedCount }}
          </dd>
        </div>
        <div>
          <dt class="text-caption-sm text-mute">Resolved</dt>
          <dd data-testid="diff-resolved" class="text-heading-md text-success">
            {{ diff.resolved.length }}
          </dd>
        </div>
      </dl>

      <ul v-if="diff.resolved.length > 0" class="mt-4 flex flex-col gap-1">
        <li v-for="finding in diff.resolved" :key="finding.id" class="text-caption-md text-mute">
          {{ finding.ruleId }} — {{ finding.name }} —
          <code class="break-all">{{ finding.url }}</code>
        </li>
      </ul>
    </template>
  </section>
</template>
