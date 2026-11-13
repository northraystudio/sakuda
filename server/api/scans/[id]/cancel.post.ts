import { defineEventHandler, setResponseStatus } from 'h3'
import { z } from 'zod'
import { getDb } from '../../../db/client'
import { parseBody, requireParam, toHttpError } from '../../../lib/http'
import { logger } from '../../../lib/logger'
import { getJobLoop } from '../../../services/jobLoop'
import { cancelRunningScan } from '../../../services/scanCancel'

/** Stops a running scan (#74). Answers 202: the scan reaches `failed`
 * ("cancelled by user") once the current engine has stopped. The empty JSON
 * body is required so a cross-origin form post cannot trigger it. */
export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  await parseBody(event, z.object({}).strict())
  try {
    cancelRunningScan(getDb(), getJobLoop(), id)
  } catch (e) {
    toHttpError(e)
  }
  logger.info({ operation: 'scan.cancel', scanId: id }, 'scan stop requested')
  setResponseStatus(event, 202)
  return { id, cancelRequested: true }
})
