import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import pino from 'pino'
import { openDatabase } from '../../db/client'
import { createSiteCipher } from '../../domain/headerCipher'
import { CdpError } from '../../capture/cdp'
import { finishCapture, startCapture, type CaptureDeps } from '../captureService'
import { createSite } from '../siteService'
import { SiteInputSchema } from '#shared/schemas/site'

vi.mock('../../capture/cdp', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../capture/cdp')>()
  return { ...real, openTab: vi.fn(), captureTab: vi.fn(), closeBrowser: vi.fn() }
})
const cdp = await import('../../capture/cdp')
const openTab = vi.mocked(cdp.openTab)
const captureTab = vi.mocked(cdp.captureTab)
const closeBrowser = vi.mocked(cdp.closeBrowser)

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const TARGET = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const logLines: string[] = []
let deps: CaptureDeps
let siteId: string

beforeEach(() => {
  vi.resetAllMocks()
  logLines.length = 0
  const db = openDatabase({ file: ':memory:', migrationsFolder })
  siteId = createSite(
    {
      db,
      cipher: createSiteCipher(randomBytes(32).toString('base64')),
      now: () => new Date(),
      id: () => 'site-1',
    },
    SiteInputSchema.parse({
      name: 'shop',
      frontBaseUrl: 'http://localhost:3000',
      apiBaseUrl: 'http://localhost:4000',
      nucleiPaths: '/',
    }),
  ).id
  deps = {
    db,
    cdp: { baseUrl: 'http://127.0.0.1:9222', timeoutMs: 1000 },
    logger: pino({ level: 'info' }, { write: (l: string) => logLines.push(l) }),
  }
})

describe('captureService', () => {
  it('startCapture opens the site front URL in the capture browser', async () => {
    openTab.mockResolvedValue(TARGET)
    await expect(startCapture(deps, siteId)).resolves.toEqual({ targetId: TARGET })
    expect(openTab).toHaveBeenCalledWith('http://localhost:3000', deps.cdp)
  })

  it('maps an unreachable browser to 503 with the hint, and a missing site to 404', async () => {
    openTab.mockRejectedValue(new CdpError('CDP_UNREACHABLE', 'run task capture-browser'))
    await expect(startCapture(deps, siteId)).rejects.toMatchObject({
      statusCode: 503,
      code: 'CDP_UNREACHABLE',
    })
    await expect(startCapture(deps, 'nope')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('finishCapture reads front + API cookies, shuts the capture browser, and never logs values', async () => {
    captureTab.mockResolvedValue({
      origin: 'http://localhost:3000',
      cookies: [{ name: 'sid', value: 'secret-cookie-value' }],
      localStorage: [['token', 'secret-token-value']],
      sessionStorage: [],
    })
    closeBrowser.mockResolvedValue()
    const r = await finishCapture(deps, siteId, TARGET)
    expect(captureTab).toHaveBeenCalledWith(
      TARGET,
      'http://localhost:3000',
      ['http://localhost:3000/', 'http://localhost:4000/'],
      deps.cdp,
    )
    expect(r.browserStorage).toHaveLength(2)
    expect(r.headers).toEqual([{ name: 'Cookie', value: 'sid=secret-cookie-value' }])
    expect(closeBrowser).toHaveBeenCalledWith(deps.cdp)
    expect(logLines.join('')).not.toMatch(/secret-(cookie|token)-value/)
  })

  it('still returns the capture when shutting the browser fails, and maps a wrong origin to 409', async () => {
    captureTab.mockResolvedValue({ origin: 'x', cookies: [], localStorage: [], sessionStorage: [] })
    closeBrowser.mockRejectedValue(new CdpError('CDP_UNREACHABLE', 'gone'))
    await expect(finishCapture(deps, siteId, TARGET)).resolves.toMatchObject({ headers: [] })
    expect(logLines.join('')).toContain('capture.close')

    captureTab.mockRejectedValue(new CdpError('WRONG_ORIGIN', 'still on the IdP'))
    await expect(finishCapture(deps, siteId, TARGET)).rejects.toMatchObject({ statusCode: 409 })
  })
})
