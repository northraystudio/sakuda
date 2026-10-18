import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { allowedHostsWarnings, EnvError, getEnv, retiredEnvWarnings } from '../config/env'
import { closeDb, getDb } from '../db/client'
import { createSiteCipher } from '../domain/headerCipher'
import { engineRunners } from '../engines'
import { runDiscover } from '../engines/discover'
import { createJobLoop } from '../services/jobLoop'
import { recoverInterruptedDiscoveries } from '../services/discoveryService'
import { recoverInterruptedScans } from '../services/scanService'
import { logger } from '../lib/logger'

const POLL_MS = 2000

export default defineNitroPlugin((nitroApp) => {
  let env
  try {
    env = getEnv()
  } catch (e) {
    if (e instanceof EnvError) logger.fatal({ err: e }, e.message)
    throw e // boot must still fail
  }
  for (const message of retiredEnvWarnings(process.env))
    logger.warn({ operation: 'boot.env' }, message)
  for (const message of allowedHostsWarnings(env))
    logger.warn({ operation: 'boot.env', allowedHosts: env.allowedHosts }, message)

  mkdirSync(env.scansDir, { recursive: true })
  mkdirSync(env.discoveriesDir, { recursive: true })
  const db = getDb()

  const recovered = recoverInterruptedScans(db, () => new Date())
  if (recovered > 0) logger.warn({ recovered }, 'marked interrupted scans as failed')
  const recoveredDiscoveries = recoverInterruptedDiscoveries(db, () => new Date())
  if (recoveredDiscoveries > 0)
    logger.warn({ recovered: recoveredDiscoveries }, 'marked interrupted discoveries as failed')

  if (!env.jobRunner) {
    logger.info('job runner disabled (SAKUDA_JOB_RUNNER=off)')
    return
  }

  const loop = createJobLoop({
    db,
    env,
    cipher: createSiteCipher(env.encryptionKey),
    runners: engineRunners,
    discover: runDiscover,
    logger,
    now: () => new Date(),
    id: randomUUID,
    pollMs: POLL_MS,
  })
  loop.start()
  logger.info(
    { dataDir: env.dataDir, nucleiBin: env.nuclei.bin, zapCmd: env.zap.cmd },
    'job runner started',
  )

  nitroApp.hooks.hook('close', async () => {
    await loop.stop()
    closeDb()
  })
})
