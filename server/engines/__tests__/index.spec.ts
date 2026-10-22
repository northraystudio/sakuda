import { describe, expect, it } from 'vitest'
import { runBoundary } from '../boundary'
import { runDalfox } from '../dalfox'
import { runNuclei } from '../nuclei'
import { runZapApi } from '../zap/zapApi'
import { runZapFe } from '../zap/zapFe'
import { engineRunners, ENGINE_ORDER, orderEngines } from '../index'

describe('ENGINE_ORDER / engineRunners', () => {
  it('lists zap-api, zap-fe, dalfox, boundary, nuclei in that order (nuclei runs last so it can pick up zap-fe reached URLs)', () => {
    expect(ENGINE_ORDER).toEqual(['zap-api', 'zap-fe', 'dalfox', 'boundary', 'nuclei'])
  })

  it('maps every engine to its runner', () => {
    expect(engineRunners.nuclei).toBe(runNuclei)
    expect(engineRunners['zap-api']).toBe(runZapApi)
    expect(engineRunners['zap-fe']).toBe(runZapFe)
    expect(engineRunners.dalfox).toBe(runDalfox)
    expect(engineRunners.boundary).toBe(runBoundary)
  })
})

describe('orderEngines', () => {
  it('reorders to ENGINE_ORDER regardless of input order', () => {
    expect(orderEngines(['boundary', 'dalfox', 'zap-fe', 'nuclei', 'zap-api'])).toEqual([
      'zap-api',
      'zap-fe',
      'dalfox',
      'boundary',
      'nuclei',
    ])
  })

  it('drops engines not present in the input', () => {
    expect(orderEngines(['zap-fe'])).toEqual(['zap-fe'])
  })

  it('returns an empty array for an empty input', () => {
    expect(orderEngines([])).toEqual([])
  })
})
