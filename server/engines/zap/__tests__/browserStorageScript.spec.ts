import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildBrowserStorageScript, BROWSER_STORAGE_SCRIPT_ENGINE } from '../browserStorageScript'

describe('buildBrowserStorageScript', () => {
  const items = [
    { kind: 'localStorage' as const, name: 'token', value: 'ey"J\'.<script>' },
    { kind: 'sessionStorage' as const, name: 'bid', value: '6' },
    { kind: 'cookie' as const, name: 'token', value: 'eyJ.abc' },
  ]

  it('embeds items and origins as JSON, and passes values as executeScript arguments', () => {
    const script = buildBrowserStorageScript(items, ['http://host.docker.internal:4001'])
    expect(script).toContain(`var ITEMS = ${JSON.stringify(items)};`)
    expect(script).toContain('var ORIGINS = ["http://host.docker.internal:4001"];')
    // the value never appears unescaped inside JS source — only inside the JSON literal
    expect(script.split(items[0]!.value)).toHaveLength(1) // raw value not present
    expect(script).toContain('window[arguments[0]].setItem(arguments[1], arguments[2])')
    expect(script).toContain("document.cookie = arguments[0] + '=' + arguments[1] + '; path=/'")
  })

  it('defines the browserLaunched hook, navigates to the origin first and reloads at the end', () => {
    const script = buildBrowserStorageScript(items, ['http://a.example', 'http://b.example'])
    expect(script).toContain('function browserLaunched(utils)')
    expect(script).toContain("wd.get(ORIGINS[o] + '/')")
    expect(script).toContain("wd.executeScript('location.reload()')")
    expect(BROWSER_STORAGE_SCRIPT_ENGINE).toBe('ECMAScript : Graal.js')
  })
})

/** A fake Selenium WebDriver: records calls; `failOnWrite` makes every
 * storage write throw the way Selenium does — with the arguments in the
 * message. */
function fakeDriver(currentUrl: string, failOnWrite = false) {
  const calls: string[] = []
  let url = currentUrl
  const wd = {
    getCurrentUrl: () => url,
    get: (u: string) => {
      calls.push(`get ${u}`)
      url = u
    },
    executeScript: (script: string, ...args: string[]) => {
      if (failOnWrite && script.includes('setItem')) {
        throw new Error(
          `SecurityError: The operation is insecure. Command: executeScript args=[${args.join(', ')}]`,
        )
      }
      calls.push(`exec ${script.slice(0, 30)}`)
    },
  }
  return { wd, calls }
}

/** Runs the generated script's browserLaunched hook in a fresh context. The
 * hook only touches `utils` and `print`, like it does inside ZAP's Graal.js. */
function runHook(script: string, wd: unknown, plannedUrl: string): void {
  const ctx: Record<string, unknown> = { print: () => {} }
  runInNewContext(script, ctx)
  const hook = ctx.browserLaunched as (utils: unknown) => void
  hook({
    getWebDriver: () => wd,
    waitForURL: () => plannedUrl,
    getBrowserId: () => 'firefox-headless',
  })
}

describe('browserLaunched hook (run against a fake WebDriver)', () => {
  const origin = 'http://host.docker.internal:4001'
  const items = [{ kind: 'localStorage' as const, name: 'token', value: 'eyJ.secret-jwt' }]

  it('re-throws a failed write without the stored value', () => {
    const { wd } = fakeDriver(`${origin}/`, true)
    let message = ''
    try {
      runHook(buildBrowserStorageScript(items, [origin]), wd, `${origin}/`)
    } catch (e) {
      // The hook runs in another vm context, so its Error fails `instanceof Error` here.
      message = String((e as { message?: unknown }).message)
    }
    expect(message).toBe(`[sakuda-browser-storage] could not set localStorage "token" on ${origin}`)
    expect(message).not.toContain('secret-jwt')
  })
})
