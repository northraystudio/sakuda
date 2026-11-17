import { describe, expect, it } from 'vitest'
import type { ExpandedTarget } from '../../../domain/nucleiTargets'
import { boundaryCases } from '../cases'
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
    const { operations: ops } = operationsFromOpenApi(
      JSON.stringify(doc),
      'http://api.test/',
      never,
    )
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
    const { operations: ops } = operationsFromOpenApi(
      JSON.stringify(withServers),
      'http://api.test',
      never,
    )
    expect(ops.every((o) => o.url.startsWith('http://api.test/'))).toBe(true)
    expect(ops.some((o) => o.method === ('DELETE' as string))).toBe(false)
    expect(ops.some((o) => o.url.endsWith('/upload'))).toBe(false)
  })

  it('drops excluded paths and survives invalid documents', () => {
    const { operations: ops } = operationsFromOpenApi(JSON.stringify(doc), 'http://api.test', (p) =>
      p.startsWith('/users/'),
    )
    expect(ops.map((o) => o.url)).toEqual(['http://api.test/users'])
    const nothing = { operations: [], skipped: [] }
    expect(operationsFromOpenApi('not json', 'http://api.test', never)).toEqual(nothing)
    expect(operationsFromOpenApi('{"paths":1}', 'http://api.test', never)).toEqual(nothing)
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
    expect(operationsFromOpenApi(JSON.stringify(external), 'http://api.test', never)).toEqual({
      operations: [],
      skipped: [{ method: 'POST', path: '/x', reason: 'unsupported-schema' }],
    })
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
    const { operations: ops } = operationsFromOpenApi(
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
      expect(
        operationsFromOpenApi(JSON.stringify(body(ref)), 'http://api.test', never).operations,
      ).toEqual([])
    }
  })

  // FastAPI writes Optional[T] as anyOf: [T, {type: "null"}] (Issue #87).
  const optionalDoc = {
    openapi: '3.1.0',
    paths: {
      '/partners/{company_id}': {
        patch: {
          parameters: [{ name: 'company_id', in: 'path', schema: { type: 'integer' } }],
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PartnerUpdate' } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Rank: { type: 'string', enum: ['gold', 'silver'] },
        PartnerUpdate: {
          type: 'object',
          properties: {
            importance: {
              anyOf: [{ type: 'integer', minimum: 1, maximum: 5 }, { type: 'null' }],
              default: null,
            },
            rank: { anyOf: [{ $ref: '#/components/schemas/Rank' }, { type: 'null' }] },
            note: { oneOf: [{ type: 'null' }, { type: 'string', maxLength: 20 }] },
            either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          },
        },
      },
    },
  }

  it('reads an Optional field by its non-null side, including a $ref inside it', () => {
    const { operations, skipped } = operationsFromOpenApi(
      JSON.stringify(optionalDoc),
      'http://api.test',
      never,
    )
    expect(skipped).toEqual([])
    expect(operations).toHaveLength(1)
    const op = operations[0]!
    expect(op.fields.find((f) => f.name === 'importance')).toMatchObject({
      type: 'integer',
      required: false,
      minimum: 1,
      maximum: 5,
    })
    expect(op.fields.find((f) => f.name === 'rank')).toMatchObject({
      type: 'string',
      enum: ['gold', 'silver'],
    })
    expect(op.fields.find((f) => f.name === 'note')).toMatchObject({
      type: 'string',
      maxLength: 20,
    })
    // A union of two real types is not guessed at.
    expect(op.fields.some((f) => f.name === 'either')).toBe(false)
    expect(op.skippedFields).toBe(1)
  })

  it('plans out-of-range values for an Optional field (PartnerUpdate.importance)', () => {
    const { operations } = operationsFromOpenApi(
      JSON.stringify(optionalDoc),
      'http://api.test',
      never,
    )
    const sent = boundaryCases(operations[0]!.fields)
      .filter((c) => c.field === 'importance')
      .map((c) => [c.kind, c.sent])
    expect(sent).toContainEqual(['below-minimum', 0])
    expect(sent).toContainEqual(['above-maximum', 6])
  })

  const FINDING = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
  const uuidDoc = {
    paths: {
      '/orgs/self/findings/{finding_id}/status': {
        put: {
          parameters: [
            { name: 'finding_id', in: 'path', schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { status: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
  }
  const urlsFor = (base: string, saved: string[] = []) =>
    operationsFromOpenApi(JSON.stringify(uuidDoc), base, never, saved).operations.map((o) => o.url)

  it('fills a uuid path parameter with a fixed, well-formed placeholder', () => {
    expect(urlsFor('http://api.test')).toEqual([
      'http://api.test/orgs/self/findings/00000000-0000-4000-8000-000000000000/status',
    ])
  })

  it('prefers a real id from a saved URL whose path agrees up to the parameter', () => {
    expect(
      urlsFor('http://api.test', [
        'http://api.test/orgs/self/findings/summary', // not a uuid: not an id
        'http://other.test/orgs/self/findings/11111111-1111-4111-8111-111111111111', // other origin
        'http://api.test/orgs/other/findings/22222222-2222-4222-8222-222222222222', // other path
        `http://api.test/orgs/self/findings/${FINDING}`,
      ]),
    ).toEqual([`http://api.test/orgs/self/findings/${FINDING}/status`])
  })

  it('matches saved URLs under the base URL’s own path prefix', () => {
    expect(
      urlsFor('http://api.test/v1/', [`http://api.test/v1/orgs/self/findings/${FINDING}`]),
    ).toEqual([`http://api.test/v1/orgs/self/findings/${FINDING}/status`])
    // The same id outside the prefix is a different resource.
    expect(
      urlsFor('http://api.test/v1', [`http://api.test/orgs/self/findings/${FINDING}`]),
    ).toEqual(['http://api.test/v1/orgs/self/findings/00000000-0000-4000-8000-000000000000/status'])
  })

  it('keeps the document’s example ahead of a saved id, and "1" as the last resort', () => {
    const saved = ['http://api.test/users/42']
    const { operations } = operationsFromOpenApi(
      JSON.stringify(doc),
      'http://api.test',
      never,
      saved,
    )
    expect(operations.map((o) => o.url)).toContain('http://api.test/users/7') // example: 7
    const noExample = structuredClone(doc)
    noExample.paths['/users/{id}'].patch.parameters = [
      { name: 'id', in: 'path', schema: { type: 'integer' } },
    ] as never
    const urls = (s: string[]) =>
      operationsFromOpenApi(JSON.stringify(noExample), 'http://api.test', never, s).operations.map(
        (o) => o.url,
      )
    expect(urls(saved)).toContain('http://api.test/users/42')
    expect(urls(['http://api.test/users/me'])).toContain('http://api.test/users/1')
  })

  it('reports every write operation it does not use, with the reason', () => {
    const mixed = {
      paths: {
        ...doc.paths,
        '/logout': { post: {} },
        '/nested': {
          put: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { items: { type: 'array' } } },
                },
              },
            },
          },
        },
        '/list': {
          post: { requestBody: { content: { 'application/json': { schema: { type: 'array' } } } } },
        },
      },
      components: doc.components,
    }
    const { operations, skipped } = operationsFromOpenApi(
      JSON.stringify(mixed),
      'http://api.test',
      (p) => p.startsWith('/users/'),
    )
    expect(operations.map((o) => `${o.method} ${o.url}`)).toEqual(['POST http://api.test/users'])
    expect(skipped).toEqual([
      { method: 'PATCH', path: '/users/{id}', reason: 'excluded-path' },
      { method: 'POST', path: '/upload', reason: 'no-json-body' },
      { method: 'POST', path: '/logout', reason: 'no-json-body' },
      { method: 'PUT', path: '/nested', reason: 'no-testable-fields' },
      { method: 'POST', path: '/list', reason: 'unsupported-schema' },
    ])
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
