import { defineEventHandler, setResponseHeader } from 'h3'
import { z } from 'zod'
import { captureDeps } from '../../../../lib/deps'
import { parseBody, requireLoopbackRequest, requireParam, toHttpError } from '../../../../lib/http'
import { finishCapture } from '../../../../services/captureService'
import type { CaptureResult } from '#shared/types/api'

const Body = z.object({ targetId: z.string().regex(/^[0-9A-F]{32}$/i) }).strict()

/** Reads the login tab's cookies and storage as row proposals (#17). The
 * answer carries secrets: loopback-only and never cached. */
export default defineEventHandler(async (event): Promise<CaptureResult> => {
  requireLoopbackRequest(event)
  setResponseHeader(event, 'cache-control', 'no-store')
  const siteId = requireParam(event, 'id')
  const { targetId } = await parseBody(event, Body)
  try {
    return await finishCapture(captureDeps(), siteId, targetId)
  } catch (e) {
    toHttpError(e)
  }
})
