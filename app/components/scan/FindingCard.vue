<script setup lang="ts">
import type { FindingView, TriageStatus } from '#shared/types/api'
import SeverityBadge from './SeverityBadge.vue'

const TRIAGE_LABELS: Record<TriageStatus, string> = {
  confirmed: 'CONFIRMED',
  'false-positive': 'FALSE POSITIVE',
  accepted: 'ACCEPTED',
}

const props = defineProps<{ finding: FindingView }>()

const methodAndUrl = computed(() =>
  props.finding.method ? `${props.finding.method} ${props.finding.url}` : props.finding.url,
)
</script>

<template>
  <li class="card flex flex-col gap-2" data-testid="finding-card">
    <div class="flex flex-wrap items-center gap-2">
      <span class="badge text-mute">{{ ENGINE_LABELS[finding.engine] }}</span>
      <SeverityBadge :severity="finding.severity" />
      <span v-if="finding.isNew" data-testid="finding-new-badge" class="badge text-info">
        NEW
      </span>
      <span v-if="finding.triage" data-testid="finding-triage-badge" class="badge text-mute">
        {{ TRIAGE_LABELS[finding.triage.status] }}
      </span>
      <span class="text-body-md font-medium text-ink"
        >{{ finding.ruleId }} — {{ finding.name }}</span
      >
    </div>

    <code data-testid="finding-url" class="text-caption-md break-all text-mute">{{
      methodAndUrl
    }}</code>

    <p v-if="finding.triage" data-testid="finding-triage-reason" class="text-caption-md text-mute">
      Triage: {{ finding.triage.reason }}
    </p>
    <p v-if="finding.param" class="text-caption-md text-mute">Param: {{ finding.param }}</p>
    <p v-if="finding.evidence" class="text-caption-md text-mute">
      Evidence: {{ finding.evidence }}
    </p>
    <p v-if="finding.description" class="text-body-md text-ink">{{ finding.description }}</p>
    <p v-if="finding.solution" class="text-body-md text-ink">Solution: {{ finding.solution }}</p>
  </li>
</template>
