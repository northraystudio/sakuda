import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DiffSummary from '~/components/scan/DiffSummary.vue'
import FindingCard from '~/components/scan/FindingCard.vue'
import { findingFixture } from '../helpers/fixtures'

describe('finding triage display (#18)', () => {
  it('shows the verdict and its reason on a triaged finding', async () => {
    const wrapper = await mountSuspended(FindingCard, {
      props: {
        finding: findingFixture({
          triage: {
            status: 'false-positive',
            reason: 'the param is never rendered',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        }),
      },
    })
    expect(wrapper.find('[data-testid="finding-triage-badge"]').text()).toBe('FALSE POSITIVE')
    expect(wrapper.find('[data-testid="finding-triage-reason"]').text()).toBe(
      'Triage: the param is never rendered',
    )
  })

  it('shows nothing extra on an untriaged finding', async () => {
    const wrapper = await mountSuspended(FindingCard, { props: { finding: findingFixture() } })
    expect(wrapper.find('[data-testid="finding-triage-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="finding-triage-reason"]').exists()).toBe(false)
  })

  it('counts triaged would-be-new findings apart from new ones in the diff', async () => {
    const diff = { previousScanId: 'scan-0', newCount: 1, persistingCount: 2, resolved: [] }
    const shown = await mountSuspended(DiffSummary, {
      props: { diff: { ...diff, suppressedCount: 3 } },
    })
    expect(shown.find('[data-testid="diff-new"]').text()).toBe('1')
    expect(shown.find('[data-testid="diff-suppressed"]').text()).toBe('3')

    const hidden = await mountSuspended(DiffSummary, {
      props: { diff: { ...diff, suppressedCount: 0 } },
    })
    expect(hidden.find('[data-testid="diff-suppressed"]').exists()).toBe(false)
  })
})
