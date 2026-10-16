<script setup lang="ts">
import { claudeMcpAddCommand } from '#shared/utils/claudeMcpCommand'
import type { IssuedMcpKey, McpKeyView } from '#shared/types/api'

/** MCP API keys (#20): issue, reissue and revoke. A key is shown exactly
 * once — right after it is issued — and is dropped from memory on the next
 * action; the server keeps only its hash. */
const { data: keys, refresh } = await useFetch<McpKeyView[]>('/api/mcp-keys', {
  key: 'mcp-keys',
  default: () => [],
})

const label = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const issued = ref<IssuedMcpKey | null>(null)
const copied = ref<'key' | 'command' | null>(null)
/** Reissue / revoke break a client that uses the key, so each needs a second click. */
const pending = ref<{ id: string; action: 'reissue' | 'revoke' } | null>(null)

const command = computed(() =>
  issued.value && import.meta.client
    ? claudeMcpAddCommand(window.location.origin, issued.value.secret)
    : '',
)

async function run(action: () => Promise<IssuedMcpKey | null>) {
  busy.value = true
  error.value = null
  issued.value = null
  copied.value = null
  try {
    issued.value = await action()
    pending.value = null
    await refresh()
  } catch (err) {
    error.value = toApiErrorMessage(err)
  } finally {
    busy.value = false
  }
}

async function issue() {
  await run(async () => {
    const result = await $fetch<IssuedMcpKey>('/api/mcp-keys', {
      method: 'POST',
      body: { label: label.value },
    })
    label.value = ''
    return result
  })
}

async function confirm(id: string, action: 'reissue' | 'revoke') {
  if (pending.value?.id !== id || pending.value.action !== action) {
    pending.value = { id, action }
    return
  }
  await run(async () => {
    if (action === 'reissue')
      return await $fetch<IssuedMcpKey>(`/api/mcp-keys/${id}/reissue`, {
        method: 'POST',
        body: {},
      })
    await $fetch(`/api/mcp-keys/${id}`, { method: 'DELETE' })
    return null
  })
}

async function copy(what: 'key' | 'command') {
  if (!issued.value) return
  try {
    await navigator.clipboard.writeText(what === 'key' ? issued.value.secret : command.value)
    copied.value = what
  } catch {
    error.value =
      'クリップボードにコピーできませんでした。表示された値を選択してコピーしてください。'
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="font-display text-heading-xl uppercase">MCP</h1>
      <p class="mt-2 text-body-md text-mute">
        API keys for the <code>/mcp</code> endpoint. With no key, MCP accepts local requests without
        one and never reveals secrets. Once a key exists, every MCP request must send one, and
        <code>reveal: true</code> works.
      </p>
    </div>

    <form
      data-testid="issue-form"
      class="card flex flex-col gap-3 sm:flex-row sm:items-end"
      @submit.prevent="issue"
    >
      <div class="flex flex-1 flex-col gap-2">
        <label for="mcp-key-label" class="text-caption-md font-medium text-ink"
          >Label <span class="text-sale">*</span></label
        >
        <input
          id="mcp-key-label"
          v-model="label"
          data-testid="key-label"
          type="text"
          required
          maxlength="100"
          placeholder="claude-code"
          class="input-pill"
        />
      </div>
      <button
        type="submit"
        data-testid="issue-key"
        class="btn-primary"
        :disabled="busy || !label.trim()"
      >
        Issue key
      </button>
    </form>

    <p v-if="error" data-testid="mcp-key-error" role="alert" class="text-sale text-body-md">
      {{ error }}
    </p>

    <section
      v-if="issued"
      data-testid="issued-key"
      class="card flex flex-col gap-4"
      aria-labelledby="issued-key-heading"
    >
      <div>
        <h2 id="issued-key-heading" class="text-heading-md font-display uppercase">
          Key for {{ issued.key.label }}
        </h2>
        <p class="text-caption-md text-mute">
          Shown only now. sakuda keeps only a hash — if you lose it, reissue the key.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <code
          data-testid="issued-secret"
          class="flex-1 overflow-x-auto bg-soft-cloud p-4 text-caption-md"
          >{{ issued.secret }}</code
        >
        <button
          type="button"
          data-testid="copy-key"
          class="btn-secondary h-10 px-6 text-button-sm"
          @click="copy('key')"
        >
          {{ copied === 'key' ? 'Copied' : 'Copy key' }}
        </button>
      </div>
      <div class="flex items-center gap-2">
        <code
          data-testid="issued-command"
          class="flex-1 overflow-x-auto bg-soft-cloud p-4 text-caption-md whitespace-nowrap"
          >{{ command }}</code
        >
        <button
          type="button"
          data-testid="copy-command"
          class="btn-secondary h-10 px-6 text-button-sm"
          @click="copy('command')"
        >
          {{ copied === 'command' ? 'Copied' : 'Copy command' }}
        </button>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="keys-heading">
      <h2 id="keys-heading" class="text-heading-md font-display uppercase">Keys</h2>
      <p v-if="keys.length === 0" data-testid="no-keys" class="text-body-md text-mute">
        No keys yet. MCP is open to local requests and never reveals secrets.
      </p>
      <ul v-else class="flex flex-col gap-2">
        <li
          v-for="k in keys"
          :key="k.id"
          data-testid="mcp-key-row"
          class="card flex flex-wrap items-center justify-between gap-3"
        >
          <div>
            <p class="text-body-md font-medium text-ink">{{ k.label }}</p>
            <p class="text-caption-sm text-mute">
              Issued {{ k.createdAt.slice(0, 16).replace('T', ' ') }} UTC
            </p>
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              data-testid="reissue-key"
              class="btn-secondary h-10 px-6 text-button-sm"
              :disabled="busy"
              :aria-label="`Reissue key ${k.label}`"
              @click="confirm(k.id, 'reissue')"
            >
              {{
                pending?.id === k.id && pending.action === 'reissue' ? 'Confirm reissue' : 'Reissue'
              }}
            </button>
            <button
              type="button"
              data-testid="revoke-key"
              class="btn-secondary h-10 px-6 text-button-sm text-sale"
              :disabled="busy"
              :aria-label="`Revoke key ${k.label}`"
              @click="confirm(k.id, 'revoke')"
            >
              {{
                pending?.id === k.id && pending.action === 'revoke' ? 'Confirm revoke' : 'Revoke'
              }}
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
