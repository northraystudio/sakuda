import { createError, defineEventHandler, setResponseHeader } from 'h3'
import { siteDeps } from '../../../lib/deps'
import { requireParam } from '../../../lib/http'
import { getSiteSecrets } from '../../../services/siteService'

/** Decrypted header / browser-storage values for the edit form's show/hide
 * toggle (#17). Loopback-only (the `/api/**` guard, #22) and never cached;
 * values are not logged. */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const id = requireParam(event, 'id')
  const secrets = getSiteSecrets(siteDeps(), id)
  if (!secrets) throw createError({ statusCode: 404, statusMessage: 'site not found' })
  return secrets
})
