<script setup lang="ts">
import type { SiteListItem } from '#shared/types/api'

// Fetched once for the whole app (keyed) so pages don't refetch the list.
const { data: sites } = await useFetch<SiteListItem[]>('/api/sites', {
  key: 'sites-list',
  default: () => [],
})

const route = useRoute()
const activeSiteId = useActiveSiteId()

// `/sites/:id` and `/sites/:id/edit` carry the site id in the route;
// `/scans/:id` does not, so the scan page publishes it via useActiveSiteId().
const currentSiteId = computed(() => {
  if (route.path.startsWith('/sites/') && typeof route.params.id === 'string')
    return route.params.id
  if (route.path.startsWith('/scans/')) return activeSiteId.value
  return null
})

const hasSites = computed(() => (sites.value?.length ?? 0) > 0)

function onSwitch(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  if (id) navigateTo(`/sites/${id}`)
}
</script>

<template>
  <div class="min-h-screen bg-canvas text-ink">
    <header class="h-14 border-b border-hairline-soft">
      <div class="mx-auto flex h-full w-full max-w-page items-center justify-between px-6">
        <NuxtLink to="/" class="font-display text-heading-lg uppercase tracking-wide"
          >sakuda</NuxtLink
        >
        <div class="flex items-center gap-3">
          <select
            v-if="hasSites"
            data-testid="site-switcher"
            aria-label="Switch site"
            class="h-10 w-auto max-w-[60vw] rounded-full bg-soft-cloud px-4 text-button-sm font-medium text-ink outline-none focus:ring-1 focus:ring-ink sm:max-w-none"
            :value="currentSiteId ?? ''"
            @change="onSwitch"
          >
            <option value="" disabled>Switch site</option>
            <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <NuxtLink to="/mcp" class="btn-secondary h-10 px-6 text-button-sm">MCP</NuxtLink>
          <NuxtLink to="/sites/new" class="btn-secondary h-10 px-6 text-button-sm"
            >New site</NuxtLink
          >
        </div>
      </div>
    </header>
    <main class="mx-auto w-full max-w-page px-6 py-10"><slot /></main>
  </div>
</template>
