import { randomUUID } from 'node:crypto'
import { defineEventHandler, setResponseStatus } from 'h3'
import { getDb } from '../../../db/client'
import { parseBody, requireParam, toHttpError } from '../../../lib/http'
import { logger } from '../../../lib/logger'
import { createScan } from '../../../services/scanService'
import { getSite } from '../../../services/siteService'
import { CreateScanBodySchema } from '#shared/schemas/scan'
import type { CreatedScan } from '#shared/types/api'
import { findExpiryProblems, formatExpiryWarning } from '#shared/utils/secretExpiry'

export default defineEventHandler(async (event): Promise<CreatedScan> => {
  const siteId = requireParam(event, 'id')
  const { engines } = await parseBody(event, CreateScanBodySchema)
  try {
    const now = new Date()
    const db = getDb()
    const scan = createScan(db, { now: () => now, id: randomUUID }, siteId, engines)
    // An expired login does not block the scan (the user may want an
    // anonymous run) — it is reported so the result is not misread (#17).
    const problems = findExpiryProblems(getSite(db, siteId)?.secretExpiries ?? {}, now)
    if (problems.length > 0)
      logger.warn(
        { operation: 'scan.create', siteId, scanId: scan.id, secrets: problems },
        'auth secret expired or expiring soon',
      )
    setResponseStatus(event, 202)
    return { ...scan, warnings: problems.map(formatExpiryWarning) }
  } catch (e) {
    toHttpError(e)
  }
})
