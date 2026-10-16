import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureTab, CdpError, closeBrowser, isTargetId, openTab, resolveCdpBase } from '../cdp'

const TARGET = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const OPTS = { baseUrl: 'http://127.0.0.1:9222', timeoutMs: 1000 }

type Handler = (method: string, params: Record<string, unknown>) => unknown

/** Stands in for Node's global WebSocket: answers each CDP command via `handler`. */
function fakeWebSocket(handler: Handler, opened: string[]) {
  return class FakeWebSocket extends EventTarget {
    constructor(url: string) {
      super()
      opened.push(url)
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    send(data: string) {
      const { id, method, params } = JSON.parse(data) as {
        id: number
        method: string
        params: Record<string, unknown>
      } // test double: the client under test always sends this shape
      const result = handler(method, params)
      queueMicrotask(() => {
        const ev = new MessageEvent('message', { data: JSON.stringify({ id, result }) })
        this.dispatchEvent(ev)
      })
    }
    close() {
      this.dispatchEvent(new Event('close'))
    }
  }
}

function storageResult(origin: string) {
  return {
    result: {
      type: 'string',
      value: JSON.stringify({
        origin,
        local: [['token', 'eyJ.local']],
        session: [['bid', '6']],
      }),
    },
  }
}

const fetchCalls: { url: string; method: string }[] = []
let opened: string[] = []

function stubFetch(routes: Record<string, () => Response>) {
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    fetchCalls.push({ url: url.toString(), method: init?.method ?? 'GET' })
    const route = routes[url.pathname]
    if (!route) throw new TypeError('fetch failed')
    return route()
  })
}

beforeEach(() => {
  fetchCalls.length = 0
  opened = []
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isTargetId / resolveCdpBase', () => {
  it('accepts only 32-hex target ids', () => {
    expect(isTargetId(TARGET)).toBe(true)
    expect(isTargetId('../../json/version')).toBe(false)
  })

  it('keeps an IP or localhost and resolves a name to IPv4 (Chrome rejects other Host values)', async () => {
    expect((await resolveCdpBase('http://127.0.0.1:9222')).host).toBe('127.0.0.1:9222')
    expect((await resolveCdpBase('http://localhost:9222')).host).toBe('localhost:9222')
    // `localhost.` is a name, not the literal — it must resolve to an address
    expect((await resolveCdpBase('http://localhost.:9222')).hostname).toMatch(
      /^\d+\.\d+\.\d+\.\d+$/,
    )
  })
})

describe('openTab', () => {
  it('opens the target URL with PUT /json/new and returns the id', async () => {
    stubFetch({
      '/json/new': () => Response.json({ id: TARGET, type: 'page', url: 'http://localhost:3000/' }),
    })
    await expect(openTab('http://localhost:3000/', OPTS)).resolves.toBe(TARGET)
    expect(fetchCalls[0]).toEqual({
      url: `http://127.0.0.1:9222/json/new?${encodeURIComponent('http://localhost:3000/')}`,
      method: 'PUT',
    })
  })

  it('reports an unreachable browser with the make capture-browser hint', async () => {
    stubFetch({})
    const err = await openTab('http://localhost:3000/', OPTS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CdpError)
    expect(err).toMatchObject({ code: 'CDP_UNREACHABLE' })
    expect(String(err)).toContain('make capture-browser')
  })
})

describe('closeBrowser', () => {
  it('sends Browser.close on the browser socket and tolerates the dropped connection', async () => {
    stubFetch({
      '/json/version': () =>
        Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
    })
    const methods: string[] = []
    class ClosingWebSocket extends EventTarget {
      constructor(url: string) {
        super()
        opened.push(url)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }
      send(data: string) {
        methods.push(String(JSON.parse(data).method))
        // Chrome exits without answering
        queueMicrotask(() => this.dispatchEvent(new Event('close')))
      }
      close() {}
    }
    vi.stubGlobal('WebSocket', ClosingWebSocket)
    await expect(closeBrowser(OPTS)).resolves.toBeUndefined()
    expect(methods).toEqual(['Browser.close'])
    expect(opened).toEqual(['ws://127.0.0.1:9222/devtools/browser/abc'])
  })
})

describe('captureTab', () => {
  const list = () =>
    Response.json([
      {
        id: TARGET,
        type: 'page',
        url: 'http://localhost:3000/home',
        webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${TARGET}`,
      },
    ])

  it('reads storage on the expected origin and the cookies for the given URLs', async () => {
    stubFetch({ '/json/list': list })
    const calls: [string, Record<string, unknown>][] = []
    vi.stubGlobal(
      'WebSocket',
      fakeWebSocket((method, params) => {
        calls.push([method, params])
        if (method === 'Runtime.evaluate') return storageResult('http://localhost:3000')
        return {
          cookies: [
            { name: 'sid', value: 's1', expires: 1_800_000_000, httpOnly: true },
            { name: 'lang', value: 'en', expires: -1 },
          ],
        }
      }, opened),
    )
    const tab = await captureTab(
      TARGET,
      'http://localhost:3000',
      ['http://localhost:3000/', 'http://localhost:4000/'],
      OPTS,
    )
    expect(tab).toEqual({
      origin: 'http://localhost:3000',
      cookies: [
        { name: 'sid', value: 's1', expires: 1_800_000_000 },
        { name: 'lang', value: 'en', expires: -1 },
      ],
      localStorage: [['token', 'eyJ.local']],
      sessionStorage: [['bid', '6']],
    })
    expect(calls.map((c) => c[0])).toEqual(['Runtime.evaluate', 'Network.getCookies'])
    expect(calls[1]?.[1]).toEqual({ urls: ['http://localhost:3000/', 'http://localhost:4000/'] })
    expect(opened).toEqual([`ws://127.0.0.1:9222/devtools/page/${TARGET}`])
  })

  it('refuses a tab that is still on another origin (e.g. an IdP login page)', async () => {
    stubFetch({ '/json/list': list })
    vi.stubGlobal(
      'WebSocket',
      fakeWebSocket(() => storageResult('https://idp.example'), opened),
    )
    await expect(captureTab(TARGET, 'http://localhost:3000', [], OPTS)).rejects.toMatchObject({
      code: 'WRONG_ORIGIN',
    })
  })

  it('reports a closed tab as TAB_NOT_FOUND', async () => {
    stubFetch({ '/json/list': () => Response.json([]) })
    await expect(captureTab(TARGET, 'http://localhost:3000', [], OPTS)).rejects.toMatchObject({
      code: 'TAB_NOT_FOUND',
    })
  })
})
