import { captureTab, CdpError, closeBrowser, openTab, type CdpOptions } from '../capture/cdp'
import type { Db } from '../db/client'
import { buildCaptureCandidates } from '../domain/captureCandidates'
import type { Logger } from '../lib/logger'
import { ServiceError } from './errors'
import { getSite } from './siteService'
import type { CaptureResult, CaptureStart } from '#shared/types/api'

/**
 * Auth capture (#17): open the site in the host Chrome, let the user log in,
 * then read the tab's cookies and storage as edit-form row proposals. Values
 * are returned to the (loopback-only) caller and never logged or stored here
 * — saving goes through the normal site update.
 */
export interface CaptureDeps {
  db: Db
  cdp: CdpOptions
  logger: Logger
}

const CDP_STATUS: Record<CdpError['code'], number> = {
  CDP_UNREACHABLE: 503,
  TAB_NOT_FOUND: 404,
  WRONG_ORIGIN: 409,
  CDP_PROTOCOL: 502,
}

function toServiceError(err: unknown): never {
  if (err instanceof CdpError) throw new ServiceError(CDP_STATUS[err.code], err.code, err.message)
  throw err
}

function siteOrThrow(db: Db, siteId: string) {
  const site = getSite(db, siteId)
  if (!site) throw new ServiceError(404, 'SITE_NOT_FOUND', `site ${siteId} not found`)
  return site
}

export async function startCapture(deps: CaptureDeps, siteId: string): Promise<CaptureStart> {
  const site = siteOrThrow(deps.db, siteId)
  try {
    const targetId = await openTab(site.frontBaseUrl, deps.cdp)
    deps.logger.info({ operation: 'capture.start', siteId, targetId }, 'login tab opened')
    return { targetId }
  } catch (err) {
    toServiceError(err)
  }
}

export async function finishCapture(
  deps: CaptureDeps,
  siteId: string,
  targetId: string,
): Promise<CaptureResult> {
  const site = siteOrThrow(deps.db, siteId)
  const cookieUrls = [site.frontBaseUrl, site.apiBaseUrl].flatMap((u) => (u ? [`${u}/`] : []))
  let result: CaptureResult
  try {
    const tab = await captureTab(targetId, new URL(site.frontBaseUrl).origin, cookieUrls, deps.cdp)
    result = buildCaptureCandidates(tab)
  } catch (err) {
    toServiceError(err)
  }
  // Done with the capture browser: shut it so its DevTools port does not
  // stay open. Failing that is not worth failing a capture that succeeded —
  // but the user must know to close it.
  await closeBrowser(deps.cdp).catch((err: unknown) => {
    deps.logger.warn(
      { operation: 'capture.close', siteId, targetId, err: String(err) },
      'could not close the capture browser — quit that Chrome by hand',
    )
  })
  deps.logger.info(
    {
      operation: 'capture.finish',
      siteId,
      // counts only — `headers` is a redacted log path (server/lib/logger)
      headerCount: result.headers.length,
      storageCount: result.browserStorage.length,
      skippedCount: result.skipped.length,
    },
    'auth capture read',
  )
  return result
}
