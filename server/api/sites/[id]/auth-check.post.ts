import { defineEventHandler } from 'h3'
import { getEnv } from '../../../config/env'
import { siteDeps } from '../../../lib/deps'
import { parseBody, requireParam, toHttpError } from '../../../lib/http'
import { logger } from '../../../lib/logger'
import { checkAuthDraft } from '../../../services/authCheckService'
import { fetchAuthStatus } from '../../../services/authWatch'
import { AuthCheckInputSchema } from '#shared/schemas/site'
import type { AuthCheckResult } from '#shared/types/api'

/** Login check for the Edit site form (#74): the values being edited, with
 * value-less header rows filled from the stored ones. */
export default defineEventHandler(async (event): Promise<AuthCheckResult> => {
  const id = requireParam(event, 'id')
  const input = await parseBody(event, AuthCheckInputSchema)
  try {
    return await checkAuthDraft(
      { site: siteDeps(), send: fetchAuthStatus(getEnv().localhostAlias), logger },
      id,
      input,
    )
  } catch (e) {
    toHttpError(e)
  }
})
