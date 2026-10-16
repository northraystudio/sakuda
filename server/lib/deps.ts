import { randomUUID } from 'node:crypto'
import { getEnv } from '../config/env'
import { getDb } from '../db/client'
import { createSiteCipher, type SiteCipher } from '../domain/headerCipher'
import type { CaptureDeps } from '../services/captureService'
import type { McpKeyServiceDeps } from '../services/mcpKeyService'
import type { SiteServiceDeps } from '../services/siteService'
import { logger } from './logger'

let cipher: SiteCipher | undefined

function getCipher(): SiteCipher {
  cipher ??= createSiteCipher(getEnv().encryptionKey)
  return cipher
}

export function siteDeps(): SiteServiceDeps {
  return { db: getDb(), cipher: getCipher(), now: () => new Date(), id: randomUUID }
}

export function mcpKeyDeps(): McpKeyServiceDeps {
  return { db: getDb(), now: () => new Date(), id: randomUUID }
}

/** Per-call budget for each DevTools request during auth capture (#17). */
const CAPTURE_CDP_TIMEOUT_MS = 10_000

export function captureDeps(): CaptureDeps {
  return {
    db: getDb(),
    cdp: { baseUrl: getEnv().captureCdpUrl, timeoutMs: CAPTURE_CDP_TIMEOUT_MS },
    logger,
  }
}
