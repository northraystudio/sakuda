<script setup lang="ts">
/** Show/hide toggle for a secret value input (#17) — {component.button-icon-circular}. */
defineProps<{ revealed: boolean; label: string }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    class="btn-icon shrink-0"
    :aria-label="revealed ? `Hide ${label}` : `Show ${label}`"
    :aria-pressed="revealed"
    @click="$emit('toggle')"
  >
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      <path v-if="revealed" d="M3 3l18 18" />
    </svg>
  </button>
</template>
