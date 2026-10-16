import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import McpPage from '~/pages/mcp-keys.vue'
import type { IssuedMcpKey, McpKeyView } from '#shared/types/api'

const SECRET = 'sakuda_' + 'a'.repeat(43)
const existing: McpKeyView = { id: 'k1', label: 'ci', createdAt: '2026-10-16T01:02:03.000Z' }

let store: McpKeyView[]
const calls: string[] = []

beforeEach(() => {
  clearNuxtData()
  store = [existing]
  calls.length = 0
  registerEndpoint('/api/mcp-keys', {
    method: 'GET',
    handler: () => store,
  })
  registerEndpoint('/api/mcp-keys', {
    method: 'POST',
    handler: (): IssuedMcpKey => {
      calls.push('issue')
      const key = { id: 'k2', label: 'claude-code', createdAt: '2026-10-16T02:00:00.000Z' }
      store = [...store, key]
      return { key, secret: SECRET }
    },
  })
  registerEndpoint('/api/mcp-keys/k1/reissue', {
    method: 'POST',
    handler: (): IssuedMcpKey => {
      calls.push('reissue')
      return { key: existing, secret: SECRET }
    },
  })
  registerEndpoint('/api/mcp-keys/k1', {
    method: 'DELETE',
    handler: () => {
      calls.push('revoke')
      store = []
      return null
    },
  })
})

describe('pages/mcp-keys', () => {
  it('lists keys without any secret', async () => {
    const wrapper = await mountSuspended(McpPage, { route: '/mcp-keys' })
    expect(wrapper.findAll('[data-testid="mcp-key-row"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('ci')
    expect(wrapper.find('[data-testid="issued-key"]').exists()).toBe(false)
  })

  it('shows the key and pasteable claude mcp remove + add commands once, and copies them', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = await mountSuspended(McpPage, { route: '/mcp-keys' })
    await wrapper.find('[data-testid="key-label"]').setValue('claude-code')
    await wrapper.find('[data-testid="issue-form"]').trigger('submit')
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="mcp-key-row"]')).toHaveLength(2))

    expect(calls).toEqual(['issue'])
    expect(wrapper.find('[data-testid="issued-secret"]').text()).toBe(SECRET)
    const command = wrapper.find('[data-testid="issued-command"]').text()
    expect(command).toBe(
      'claude mcp remove sakuda -s local\n' +
        `claude mcp add --transport http sakuda ${window.location.origin}/mcp ` +
        `--header "Authorization: Bearer ${SECRET}"`,
    )

    await wrapper.find('[data-testid="copy-command"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(command)
  })

  it('reissue and revoke need a second click', async () => {
    const wrapper = await mountSuspended(McpPage, { route: '/mcp-keys' })
    await wrapper.find('[data-testid="reissue-key"]').trigger('click')
    expect(calls).toEqual([])
    expect(wrapper.find('[data-testid="reissue-key"]').text()).toBe('Confirm reissue')
    await wrapper.find('[data-testid="reissue-key"]').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="issued-secret"]').exists()).toBe(true),
    )
    expect(calls).toEqual(['reissue'])
    expect(wrapper.find('[data-testid="issued-secret"]').text()).toBe(SECRET)

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="revoke-key"]').attributes('disabled')).toBeUndefined(),
    )
    await wrapper.find('[data-testid="revoke-key"]').trigger('click')
    expect(wrapper.find('[data-testid="revoke-key"]').text()).toBe('Confirm revoke')
    expect(calls).toEqual(['reissue'])
    await wrapper.find('[data-testid="revoke-key"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="no-keys"]').exists()).toBe(true))
    expect(calls).toEqual(['reissue', 'revoke'])
    // the earlier key is not left on screen after another action
    expect(wrapper.find('[data-testid="issued-key"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="no-keys"]').exists()).toBe(true)
  })
})
