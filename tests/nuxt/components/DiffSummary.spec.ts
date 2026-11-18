import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DiffSummary from '~/components/scan/DiffSummary.vue'
import { findingFixture } from '../helpers/fixtures'
import type { ScanDiff } from '#shared/types/api'

const base: ScanDiff = {
  previousScanId: 'scan-0',
  newCount: 1,
  persistingCount: 2,
  suppressedCount: 0,
  resolved: [],
  unverified: [],
}

describe('DiffSummary (#89)', () => {
  it('lists resolved and not-checked findings under separate headings, with the reason', async () => {
    const wrapper = await mountSuspended(DiffSummary, {
      props: {
        diff: {
          ...base,
          resolved: [findingFixture({ id: 'f-1', ruleId: 'fixed-rule', engine: 'zap-fe' })],
          unverified: [
            {
              ...findingFixture({ id: 'f-2', ruleId: 'nosql-injection', engine: 'zap-api' }),
              unverifiedReason: 'engine-not-run',
            },
            {
              ...findingFixture({ id: 'f-3', ruleId: 'sitemap-rule', engine: 'zap-fe' }),
              unverifiedReason: 'url-not-reached',
            },
          ],
        },
      },
    })
    expect(wrapper.find('[data-testid="diff-resolved"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="diff-unverified"]').text()).toBe('2')

    const resolved = wrapper.find('[data-testid="diff-resolved-list"]')
    expect(resolved.find('h3').text()).toBe('Resolved — checked, no longer detected')
    expect(resolved.text()).toContain('fixed-rule')
    expect(resolved.text()).not.toContain('nosql-injection')

    const unverified = wrapper.find('[data-testid="diff-unverified-list"]')
    expect(unverified.find('h3').text()).toBe('Not checked this time — may still be present')
    expect(unverified.text()).toContain('nosql-injection')
    expect(unverified.text()).toContain('zap-api: engine did not run')
    expect(unverified.text()).toContain('zap-fe: URL not reached')
    expect(unverified.text()).not.toContain('fixed-rule')
  })

  it('shows neither the not-checked count nor its list when there is none', async () => {
    const wrapper = await mountSuspended(DiffSummary, { props: { diff: base } })
    expect(wrapper.find('[data-testid="diff-unverified"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="diff-unverified-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="diff-resolved-list"]').exists()).toBe(false)
  })
})
