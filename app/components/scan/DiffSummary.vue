<script setup lang="ts">
import type { ScanDiff, UnverifiedReason } from '#shared/types/api'

defineProps<{ diff: ScanDiff | null }>()

const UNVERIFIED_REASON_LABEL: Record<UnverifiedReason, string> = {
  'engine-not-run': 'engine did not run',
  'url-not-reached': 'URL not reached',
  'reach-unknown': 'no record of the URLs reached',
}
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
        <div v-if="diff.unverified.length > 0">
          <dt class="text-caption-sm text-mute">Not checked</dt>
          <dd data-testid="diff-unverified" class="text-heading-md text-ink">
            {{ diff.unverified.length }}
          </dd>
        </div>
      </dl>

      <section v-if="diff.resolved.length > 0" class="mt-4" data-testid="diff-resolved-list">
        <h3 class="text-caption-sm text-success">Resolved — checked, no longer detected</h3>
        <ul class="mt-1 flex flex-col gap-1">
          <li v-for="finding in diff.resolved" :key="finding.id" class="text-caption-md text-mute">
            {{ finding.ruleId }} — {{ finding.name }} —
            <code class="break-all">{{ finding.url }}</code>
          </li>
        </ul>
      </section>

      <section v-if="diff.unverified.length > 0" class="mt-4" data-testid="diff-unverified-list">
        <h3 class="text-caption-sm text-ink">Not checked this time — may still be present</h3>
        <ul class="mt-1 flex flex-col gap-1">
          <li
            v-for="finding in diff.unverified"
            :key="finding.id"
            class="text-caption-md text-mute"
          >
            {{ finding.ruleId }} — {{ finding.name }} —
            <code class="break-all">{{ finding.url }}</code>
            — {{ finding.engine }}: {{ UNVERIFIED_REASON_LABEL[finding.unverifiedReason] }}
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>
