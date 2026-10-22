import { describe, expect, it } from 'vitest'
import type { ExpandedTarget } from '../../../domain/nucleiTargets'
import { operationsFromOpenApi, operationsFromShapes } from '../operations'

const never = () => false

const doc = {
  openapi: '3.0.0',
  paths: {
    '/users': {
      post: {
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/NewUser' } },
          },
        },
      },
      get: {},
    },
    '/users/{id}': {
      patch: {
        parameters: [{ name: 'id', in: 'path', schema: { type: 'integer', example: 7 } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { nickname: { type: 'string' } } },
            },
          },
        },
      },
      delete: {},
    },
    '/upload': {
      post: {
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
      },
    },
  },
  components: {
    schemas: {
      NewUser: {
        type: 'object',
        required: ['age'],
        properties: {
          age: { type: 'integer', minimum: 0, maximum: 120 },
          role: { type: 'string', enum: ['user', 'admin'] },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

describe('operationsFromOpenApi', () => {
  it('reads JSON-body writes, resolves $ref, fills path params and skips containers', () => {
    const ops = operationsFromOpenApi(JSON.stringify(doc), 'http://api.test/', never)
    expect(ops.map((o) => `${o.method} ${o.url}`)).toEqual([
      'POST http://api.test/users',
      'PATCH http://api.test/users/7',
    ])
    const create = ops[0]!
    expect(create.skippedFields).toBe(1) // tags
    expect(create.fields.find((f) => f.name === 'age')).toMatchObject({
      type: 'integer',
      required: true,
      minimum: 0,
      maximum: 120,
    })
    expect(create.fields.find((f) => f.name === 'role')?.enum).toEqual(['user', 'admin'])
  })

  it('ignores the document’s servers and never emits DELETE or non-JSON bodies', () => {
    const withServers = { ...doc, servers: [{ url: 'http://elsewhere.test' }] }
    const ops = operationsFromOpenApi(JSON.stringify(withServers), 'http://api.test', never)
    expect(ops.every((o) => o.url.startsWith('http://api.test/'))).toBe(true)
    expect(ops.some((o) => o.method === ('DELETE' as string))).toBe(false)
    expect(ops.some((o) => o.url.endsWith('/upload'))).toBe(false)
  })

  it('drops excluded paths and survives invalid documents', () => {
    const ops = operationsFromOpenApi(JSON.stringify(doc), 'http://api.test', (p) =>
      p.startsWith('/users/'),
    )
    expect(ops.map((o) => o.url)).toEqual(['http://api.test/users'])
    expect(operationsFromOpenApi('not json', 'http://api.test', never)).toEqual([])
    expect(operationsFromOpenApi('{"paths":1}', 'http://api.test', never)).toEqual([])
  })

  it('does not follow a $ref outside the document', () => {
    const external = {
      paths: {
        '/x': {
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: 'http://evil.test/s.json' } } },
            },
          },
        },
      },
    }
    expect(operationsFromOpenApi(JSON.stringify(external), 'http://api.test', never)).toEqual([])
  })

  it('resolves a requestBody $ref to components.requestBodies and rejects other refs', () => {
    const body = (ref: string) => ({
      paths: { '/x': { post: { requestBody: { $ref: ref } } } },
      components: {
        requestBodies: {
          Item: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { qty: { type: 'integer', minimum: 1 } } },
              },
            },
          },
          Loop: { $ref: '#/components/requestBodies/Loop' },
        },
      },
    })
    const ops = operationsFromOpenApi(
      JSON.stringify(body('#/components/requestBodies/Item')),
      'http://api.test',
      never,
    )
    expect(ops).toHaveLength(1)
    expect(ops[0]?.fields.map((f) => f.name)).toEqual(['qty'])
    for (const ref of [
      '#/components/requestBodies/Loop',
      '#/components/requestBodies/Missing',
      'http://evil.test/b.json',
    ]) {
      expect(operationsFromOpenApi(JSON.stringify(body(ref)), 'http://api.test', never)).toEqual([])
    }
  })
})

describe('operationsFromShapes', () => {
  const target = (method: ExpandedTarget['method'], path: string): ExpandedTarget => ({
    method,
    base: 'front',
    path,
    url: `http://app.test${path}`,
  })
  const shapes = {
    'POST|front|/api/items': {
      contentType: 'application/json',
      bodyShape: {
        kind: 'json' as const,
        root: {
          type: 'object' as const,
          fields: {
            title: { type: 'string' as const },
            qty: { type: 'number' as const },
            meta: { type: 'object' as const, truncated: true as const },
          },
        },
      },
    },
    'PUT|front|/api/form': {
      contentType: 'application/x-www-form-urlencoded',
      bodyShape: { kind: 'form' as const, fields: ['a'] },
    },
  }

  it('builds typed, range-free fields for approved write lines with a JSON shape', () => {
    const ops = operationsFromShapes(
      [
        target('POST', '/api/items'),
        target('GET', '/api/items'),
        target('PUT', '/api/form'),
        target('POST', '/api/unknown'),
      ],
      shapes,
    )
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      method: 'POST',
      url: 'http://app.test/api/items',
      skippedFields: 1,
    })
    expect(ops[0]!.fields).toEqual([
      { name: 'title', type: 'string', required: false },
      { name: 'qty', type: 'number', required: false },
    ])
  })
})
