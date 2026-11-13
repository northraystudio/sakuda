import { defineEventHandler } from 'h3'
import { getEnv } from '../config/env'
import { siteDeps } from '../lib/deps'
import { parseBody, toHttpError } from '../lib/http'
import { logger } from '../lib/logger'
import { checkAuthDraft } from '../services/authCheckService'
import { fetchAuthStatus } from '../services/authWatch'
import { AuthCheckInputSchema } from '#shared/schemas/site'
import type { AuthCheckResult } from '#shared/types/api'

/** Login check for a site not saved yet (#74, the New site form). */
export default defineEventHandler(async (event): Promise<AuthCheckResult> => {
  const input = await parseBody(event, AuthCheckInputSchema)
  try {
    return await checkAuthDraft(
      { site: siteDeps(), send: fetchAuthStatus(getEnv().localhostAlias), logger },
      null,
      input,
    )
  } catch (e) {
    toHttpError(e)
  }
})
