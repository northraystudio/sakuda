import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { captureDeps } from '../../../../lib/deps'
import { parseBody, requireParam, toHttpError } from '../../../../lib/http'
import { startCapture } from '../../../../services/captureService'
import type { CaptureStart } from '#shared/types/api'

/** Opens the site in the host capture browser (#17). Loopback-only (the
 * `/api/**` guard, #22): it drives a browser on the operator's machine. */
export default defineEventHandler(async (event): Promise<CaptureStart> => {
  const siteId = requireParam(event, 'id')
  await parseBody(event, z.object({}).strict())
  try {
    return await startCapture(captureDeps(), siteId)
  } catch (e) {
    toHttpError(e)
  }
})
