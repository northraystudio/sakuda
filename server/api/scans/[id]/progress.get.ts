import { createError, defineEventHandler } from 'h3'
import { getEnv } from '../../../config/env'
import { getDb } from '../../../db/client'
import { requireParam } from '../../../lib/http'
import { getScanProgress } from '../../../services/scanProgressService'

export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  const progress = await getScanProgress(getDb(), getEnv().scansDir, id)
  if (!progress) throw createError({ statusCode: 404, statusMessage: 'scan not found' })
  return progress
})
