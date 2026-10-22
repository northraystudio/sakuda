import { describe, expect, it } from 'vitest'
import { summarizeTargets, type TargetSummarySite } from '../targetSummary'
import type { TargetRef } from '#shared/types/api'

const site: TargetSummarySite = {
  frontBaseUrl: 'http://localhost:3000',
  apiBaseUrl: 'http://localhost:8080',
  nucleiPaths: '/\n/#/search?q=\nPOST /rest/user/login\napi:/v1/users\n/logout',
  excludePaths: '/logout',
  openapiUrl: null,
  openapiJson: null,
  allowMutatingRequests: false,
  requiresConfirmation: false,
  nonLocalConfirmed: false,
}
const active: TargetSummarySite = { ...site, allowMutatingRequests: true }

const root: TargetRef = { method: 'GET', base: 'front', path: '/' }
const hash: TargetRef = { method: 'GET', base: 'front', path: '/#/search?q=' }
const login: TargetRef = { method: 'POST', base: 'front', path: '/rest/user/login' }
const api: TargetRef = { method: 'GET', base: 'api', path: '/v1/users' }

describe('summarizeTargets', () => {
  it('lists the saved lines after exclusion, as paths only, and counts the excluded ones', () => {
    const s = summarizeTargets(site)
    expect(s.configured).toBe(true)
    expect(s.activeChecks).toBe(false)
    expect(s.common).toEqual([root, hash, login, api])
    expect(s.excludedCount).toBe(1)
    expect(JSON.stringify(s)).not.toContain('localhost')
  })

  it('passive run: nuclei/zap-fe take GET server-reachable lines, non-GET and hash routes are skipped; zap-api and dalfox are unavailable', () => {
    const { engines, zapApiSource } = summarizeTargets(site)
    expect(engines.nuclei).toEqual({
      available: true,
      targets: [root, api],
      skipped: [hash, login],
    })
    expect(engines['zap-fe']).toEqual({
      available: true,
      targets: [root],
      skipped: [hash, login, api],
    })
    expect(engines['zap-api']).toEqual({
      available: false,
      targets: [],
      skipped: [root, hash, login, api],
    })
    expect(zapApiSource).toBe('none')
    expect(engines.dalfox).toEqual({
      available: false,
      targets: [],
      skipped: [root, hash, login, api],
    })
  })

  it('active run: non-GET lines are replayed (nuclei, zap-fe, zap-api generated doc), hash routes go to the zap-fe DOM probe, dalfox takes GET lines', () => {
    const { engines, zapApiSource, activeChecks } = summarizeTargets(active)
    expect(activeChecks).toBe(true)
    expect(engines.nuclei.targets).toEqual([root, login, api])
    expect(engines.nuclei.skipped).toEqual([hash])
    expect(engines['zap-fe'].targets).toEqual([root, hash, login])
    expect(engines['zap-fe'].skipped).toEqual([api])
    expect(engines['zap-api']).toEqual({
      available: true,
      targets: [login],
      skipped: [root, hash, api],
    })
    expect(zapApiSource).toBe('generated')
    expect(engines.dalfox).toEqual({
      available: true,
      targets: [root, api],
      skipped: [hash, login],
    })
  })

  it('boundary: takes the POST/PUT/PATCH lines only under active checks', () => {
    expect(summarizeTargets(site).engines.boundary).toEqual({
      available: false,
      targets: [],
      skipped: [root, hash, login, api],
    })
    expect(summarizeTargets(active).engines.boundary).toEqual({
      available: true,
      targets: [login],
      skipped: [root, hash, api],
    })
  })

  it('names the zap-api source: openapi alone, or openapi+generated', () => {
    expect(
      summarizeTargets({ ...site, openapiUrl: 'http://localhost:8080/doc.json' }).zapApiSource,
    ).toBe('openapi')
    expect(summarizeTargets({ ...active, openapiJson: '{}' }).zapApiSource).toBe(
      'openapi+generated',
    )
    expect(summarizeTargets({ ...site, openapiJson: '{}' }).engines['zap-api'].available).toBe(true)
  })

  it('unconfigured: nuclei falls back to the base roots, the other engines see no saved lines', () => {
    const s = summarizeTargets({ ...site, nucleiPaths: '' })
    expect(s.configured).toBe(false)
    expect(s.common).toEqual([])
    expect(s.engines.nuclei.targets).toEqual([root, { method: 'GET', base: 'api', path: '/' }])
    expect(s.engines['zap-fe']).toEqual({ available: true, targets: [], skipped: [] })
    expect(s.engines.dalfox.targets).toEqual([])
  })
})
