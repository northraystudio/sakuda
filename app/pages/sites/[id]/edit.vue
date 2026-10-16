<script setup lang="ts">
import DiscoveryPanel from '~/components/site/DiscoveryPanel.vue'
import SiteForm from '~/components/site/SiteForm.vue'
import type { SiteUpdateInput } from '#shared/schemas/site'
import type { CaptureResult, CaptureStart, SitePublic, SiteSecrets } from '#shared/types/api'

const route = useRoute()
// `route.params.id` is `string | string[]` generically; this route only has
// a single `[id]` segment, so it is always a plain string at runtime.
const rawSiteId = route.params.id
const siteId = Array.isArray(rawSiteId) ? (rawSiteId[0] ?? '') : rawSiteId

const { data: site, error: loadError } = await useFetch<SitePublic>(`/api/sites/${siteId}`)

const submitting = ref(false)
const errorMessage = ref<string | null>(null)

/** The discovery panel (in the form's `targets` slot) saves and removes
 * targets through its own endpoints and hands the updated site back; swapping
 * our copy keeps its saved rows and the form's mirrored nucleiPaths in step
 * without a refetch. */
function handleTargetsChanged(updated: SitePublic) {
  site.value = updated
}

async function handleSubmit(payload: SiteUpdateInput) {
  submitting.value = true
  errorMessage.value = null
  try {
    await $fetch<SitePublic>(`/api/sites/${siteId}`, { method: 'PUT', body: payload })
    await navigateTo(`/sites/${siteId}`)
  } catch (err) {
    errorMessage.value = toApiErrorMessage(err)
  } finally {
    submitting.value = false
  }
}

/** Lazily called by the form's show/hide toggle (#17); loopback-only route. */
function loadSecrets(): Promise<SiteSecrets> {
  return $fetch<SiteSecrets>(`/api/sites/${siteId}/secrets`)
}

/** Auth capture through the host Chrome (#17); loopback-only routes. */
const capture = {
  start: () =>
    $fetch<CaptureStart>(`/api/sites/${siteId}/capture/start`, { method: 'POST', body: {} }),
  finish: (targetId: string) =>
    $fetch<CaptureResult>(`/api/sites/${siteId}/capture`, {
      method: 'POST',
      body: { targetId },
    }),
}

async function handleDelete() {
  if (!window.confirm('Delete this site? This cannot be undone.')) return
  try {
    await $fetch(`/api/sites/${siteId}`, { method: 'DELETE' })
    await navigateTo('/')
  } catch (err) {
    errorMessage.value = toApiErrorMessage(err)
  }
}
</script>

<template>
  <div>
    <h1 class="font-display text-heading-xl uppercase">Edit site</h1>

    <p v-if="loadError" class="mt-6 text-sale text-body-md">{{ toApiErrorMessage(loadError) }}</p>

    <template v-else-if="site">
      <SiteForm
        class="mt-6"
        :initial="site"
        :submitting="submitting"
        :error-message="errorMessage"
        :cancel-to="`/sites/${siteId}`"
        :load-secrets="loadSecrets"
        :capture="capture"
        @submit="handleSubmit"
      >
        <template #targets>
          <DiscoveryPanel
            :site="site"
            @saved="handleTargetsChanged"
            @removed="handleTargetsChanged"
          />
        </template>
      </SiteForm>
      <button type="button" class="btn-secondary mt-6" @click="handleDelete">Delete site</button>
    </template>
  </div>
</template>
