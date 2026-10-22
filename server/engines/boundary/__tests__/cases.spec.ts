import { describe, expect, it } from 'vitest'
import { boundaryCases, MAX_PROBE_LENGTH, validValue, type FieldSpec } from '../cases'

const age: FieldSpec = { name: 'age', type: 'integer', required: true, minimum: 0, maximum: 120 }
const name: FieldSpec = { name: 'name', type: 'string', required: true, maxLength: 10 }

describe('boundaryCases', () => {
  it('derives min/max/maxLength cases from the contract, one field out of range at a time', () => {
    const cases = boundaryCases([age, name])
    const byKind = (field: string, kind: string) =>
      cases.find((c) => c.field === field && c.kind === kind)

    expect(byKind('age', 'below-minimum')?.sent).toBe(-1)
    expect(byKind('age', 'above-maximum')?.sent).toBe(121)
    expect(byKind('name', 'too-long')?.sent).toBe('x'.repeat(11))
    // the field under test is the only one out of contract
    expect(byKind('age', 'above-maximum')?.body).toEqual({ age: 121, name: 'test' })
    expect(byKind('name', 'too-long')?.body.age).toBe(0)
  })

  it('probes a field with no stated limit only for type confusion (and emptiness if required)', () => {
    const cases = boundaryCases([{ name: 'note', type: 'string', required: true }])
    expect(cases.map((c) => c.kind).sort()).toEqual(['empty', 'wrong-type'])
    const optional = boundaryCases([{ name: 'note', type: 'string', required: false }])
    expect(optional.map((c) => c.kind)).toEqual(['wrong-type'])
  })

  it('uses a value outside the enum instead of a type probe', () => {
    const cases = boundaryCases([
      { name: 'role', type: 'string', required: true, enum: ['user', 'admin'] },
    ])
    expect(cases.find((c) => c.kind === 'not-in-enum')?.sent).toBe('sakuda-not-in-enum')
    expect(cases.some((c) => c.kind === 'wrong-type')).toBe(false)
  })

  it('picks a number past the largest numeric enum member', () => {
    const cases = boundaryCases([
      { name: 'tier', type: 'integer', required: true, enum: [1, 2, 3] },
    ])
    expect(cases.find((c) => c.kind === 'not-in-enum')?.sent).toBe(4)
  })

  it('turns minLength into a too-short case instead of an empty one', () => {
    const cases = boundaryCases([{ name: 'pw', type: 'string', required: true, minLength: 8 }])
    expect(cases.find((c) => c.kind === 'too-short')?.sent).toBe('x'.repeat(7))
    expect(cases.some((c) => c.kind === 'empty')).toBe(false)
  })

  it('does not send an absurdly long string for a huge maxLength', () => {
    const cases = boundaryCases([
      { name: 'blob', type: 'string', required: false, maxLength: MAX_PROBE_LENGTH },
    ])
    expect(cases.some((c) => c.kind === 'too-long')).toBe(false)
  })

  it('sends a wrong-typed value for each scalar type', () => {
    const sent = (type: FieldSpec['type']) =>
      boundaryCases([{ name: 'f', type, required: false }]).find((c) => c.kind === 'wrong-type')
        ?.sent
    expect(sent('string')).toBe(12345)
    expect(sent('integer')).toBe('sakuda-not-a-number')
    expect(sent('number')).toBe('sakuda-not-a-number')
    expect(sent('boolean')).toBe('sakuda-not-a-boolean')
  })
})

describe('validValue', () => {
  it('prefers the contract example, then an enum member, then a value inside the range', () => {
    expect(validValue({ name: 'a', type: 'string', required: false, example: 'hi' })).toBe('hi')
    expect(validValue({ name: 'a', type: 'string', required: false, enum: ['x', 'y'] })).toBe('x')
    expect(validValue({ name: 'a', type: 'integer', required: false, minimum: 5 })).toBe(5)
    expect(validValue({ name: 'a', type: 'integer', required: false, maximum: 0 })).toBe(0)
    expect(validValue({ name: 'a', type: 'string', required: false, minLength: 6 })).toBe('testxx')
    expect(validValue({ name: 'a', type: 'string', required: false, format: 'email' })).toBe(
      'sakuda@example.com',
    )
  })
})
