<script setup lang="ts">
import SiteForm from '~/components/site/SiteForm.vue'
import type { AuthCheckInput, SiteUpdateInput } from '#shared/schemas/site'
import type { AuthCheckResult, SitePublic } from '#shared/types/api'

const submitting = ref(false)
const errorMessage = ref<string | null>(null)

async function handleSubmit(payload: SiteUpdateInput) {
  submitting.value = true
  errorMessage.value = null
  try {
    const site = await $fetch<SitePublic>('/api/sites', { method: 'POST', body: payload })
    await navigateTo(`/sites/${site.id}`)
  } catch (err) {
    errorMessage.value = toApiErrorMessage(err)
  } finally {
    submitting.value = false
  }
}

/** Login check (#74) for a site not saved yet. */
const checkAuth = (input: AuthCheckInput) =>
  $fetch<AuthCheckResult>('/api/auth-check', { method: 'POST', body: input })
</script>

<template>
  <div>
    <h1 class="font-display text-heading-xl uppercase">New site</h1>
    <SiteForm
      class="mt-6"
      :submitting="submitting"
      :error-message="errorMessage"
      cancel-to="/"
      :check-auth="checkAuth"
      @submit="handleSubmit"
    />
  </div>
</template>
