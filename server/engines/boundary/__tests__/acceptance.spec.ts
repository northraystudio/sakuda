import { describe, expect, it, vi } from 'vitest'
import {
  judgeAcceptance,
  locateField,
  type ProbeRequest,
  type ProbeResponse,
  type Send,
} from '../acceptance'

const request: ProbeRequest = {
  method: 'POST',
  url: 'http://app.test/users',
  body: '{"age":150}',
  contentType: 'application/json',
}
const res = (
  status: number,
  body: unknown = '',
  location: string | null = null,
): ProbeResponse => ({
  status,
  location,
  body: typeof body === 'string' ? body : JSON.stringify(body),
})
const locateAge = (doc: unknown) => locateField(doc, 'age', 150)

describe('locateField', () => {
  it('reports exact, changed and absent, at the top level or one wrapper down', () => {
    expect(locateField({ age: 150 }, 'age', 150)).toBe('exact')
    expect(locateField({ data: { age: 150 } }, 'age', 150)).toBe('exact')
    expect(locateField({ age: '150' }, 'age', 150)).toBe('changed')
    expect(locateField({ age: 120 }, 'age', 150)).toBe('changed')
    expect(locateField({ name: 'x' }, 'age', 150)).toBe('absent')
    expect(locateField([{ age: 150 }], 'age', 150)).toBe('absent')
    expect(locateField(undefined, 'age', 150)).toBe('absent')
  })
})

describe('judgeAcceptance', () => {
  it('is accepted when the response body holds the sent value as-is', async () => {
    const send: Send = async () => res(201, { id: 1, age: 150 })
    expect(await judgeAcceptance(send, request, locateAge)).toEqual({
      verdict: 'accepted',
      readFrom: 'response',
    })
  })

  it('is rejected on a 4xx, even if the body echoes the value', async () => {
    const send: Send = async () => res(422, { error: 'bad', age: 150 })
    expect(await judgeAcceptance(send, request, locateAge)).toEqual({
      verdict: 'rejected',
      status: 422,
    })
  })

  it('does not treat a redirect as acceptance', async () => {
    const send: Send = async () => res(302, '', '/login')
    expect((await judgeAcceptance(send, request, locateAge)).verdict).toBe('rejected')
  })

  it('is coerced, not accepted, when the stored value differs from what was sent', async () => {
    const stringified: Send = async () => res(201, { age: '150' })
    const clamped: Send = async () => res(201, { age: 120 })
    expect((await judgeAcceptance(stringified, request, locateAge)).verdict).toBe('coerced')
    expect((await judgeAcceptance(clamped, request, locateAge)).verdict).toBe('coerced')
  })

  it('reads the resource back through Location when the response has no copy', async () => {
    const send = vi.fn<Send>(async (req) =>
      req.method === 'POST' ? res(201, '', '/users/7') : res(200, { id: 7, age: 150 }),
    )
    expect(await judgeAcceptance(send, request, locateAge)).toEqual({
      verdict: 'accepted',
      readFrom: 'location',
    })
    expect(send.mock.calls[1]![0]).toEqual({ method: 'GET', url: 'http://app.test/users/7' })
  })

  it('is coerced when the Location resource holds a different value', async () => {
    const send: Send = async (req) =>
      req.method === 'POST' ? res(201, '', '/users/7') : res(200, { age: 120 })
    expect((await judgeAcceptance(send, request, locateAge)).verdict).toBe('coerced')
  })

  it('is unverifiable when there is nothing to read back', async () => {
    const send: Send = async () => res(201, { ok: true })
    const out = await judgeAcceptance(send, request, locateAge)
    expect(out.verdict).toBe('unverifiable')
  })

  it('is unverifiable when the Location read-back fails or lacks the field', async () => {
    const missing: Send = async (req) =>
      req.method === 'POST' ? res(201, '', '/users/7') : res(404)
    const noField: Send = async (req) =>
      req.method === 'POST' ? res(201, '', '/users/7') : res(200, { id: 7 })
    expect((await judgeAcceptance(missing, request, locateAge)).verdict).toBe('unverifiable')
    expect((await judgeAcceptance(noField, request, locateAge)).verdict).toBe('unverifiable')
  })

  it('never follows a Location to another origin', async () => {
    const send = vi.fn<Send>(async () => res(201, '', 'http://evil.test/users/7'))
    const out = await judgeAcceptance(send, request, locateAge)
    expect(out.verdict).toBe('unverifiable')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
