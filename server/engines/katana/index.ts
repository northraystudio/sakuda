import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isActiveScanEnabled } from '../../domain/activeScan'
import { crawledUrlKey, normalizeCrawledEntries } from '../../domain/crawledUrls'
import { joinUrl, restoreLoopbackHost, rewriteLoopbackHost } from '../../domain/hostAlias'
import { withHeadersConfig } from '../headersConfig'
import { runCommand } from '../runCommand'
import { EngineError, OOM_RUNBOOK, type DiscoverInput, type DiscoverOutput } from '../types'
import { buildKatanaArgs, KATANA_MAX_DEPTH } from './args'
import { dropKatanaArtifacts, parseKatanaJsonl } from './normalize'
import { crawlScopePrefixes } from '#shared/utils/crawlScope'
import { resolveDiscoverySeeds } from '#shared/utils/seedPaths'
import { katanaScopeRegexes } from '../../domain/crawlScope'

/** Sub-directory of the discovery work dir: katana's files must not collide
 * with ZAP's (`stdout.log`, `plan.yaml`, …) when both run in the same job. */
export const KATANA_WORK_SUBDIR = 'katana'
export const KATANA_OUTPUT_FILE = 'urls.jsonl'

/**
 * Discovery's second URL source: a static katana crawl with JS-bundle
 * parsing (`-jc`). Same shape as `runZapDiscover` so `engines/discover` can
 * run the two side by side and merge them; runs in the app's own container
 * (like nuclei), hence `env.localhostAlias`, not ZAP's.
 */
export function runKatanaCrawl(input: DiscoverInput): Promise<DiscoverOutput> {
  // The site's headers go to katana as a 0600 `-config` file that lives
  // only for the crawl — never on argv (#95).
  return withHeadersConfig(
    join(input.workDir, KATANA_WORK_SUBDIR, 'headers.json'),
    input.site.headers,
    'headers',
    (headersConfigFile) => crawl(input, headersConfigFile),
  )
}

async function crawl(
  { discoveryId, site, workDir: discoveryWorkDir, env, logger, signal }: DiscoverInput,
  headersConfigFile: string | null,
): Promise<DiscoverOutput> {
  const workDir = join(discoveryWorkDir, KATANA_WORK_SUBDIR)
  const originalHost = new URL(site.frontBaseUrl).hostname
  const seedPaths = resolveDiscoverySeeds(site)
  const seedUrls = seedPaths.map((p) =>
    rewriteLoopbackHost(joinUrl(site.frontBaseUrl, p), env.localhostAlias),
  )
  const seedsFile = join(workDir, 'seeds.txt')
  const outputFile = join(workDir, KATANA_OUTPUT_FILE)
  const stdoutPath = join(workDir, 'stdout.log')
  const stderrPath = join(workDir, 'stderr.log')
  const maxMinutes = site.zapFeSpiderMaxMinutes
  await mkdir(workDir, { recursive: true })
  await writeFile(seedsFile, seedUrls.join('\n') + '\n')
  const args = buildKatanaArgs({
    seedsFile,
    outputFile,
    maxMinutes,
    headersConfigFile,
    crawlScopeRegexes: katanaScopeRegexes({
      seedUrls,
      front: rewriteLoopbackHost(site.frontBaseUrl + '/', env.localhostAlias).replace(/\/$/, ''),
      prefixes: crawlScopePrefixes(site.crawlScopePaths),
    }),
    // Active discovery: submit forms during the crawl (mutating) only when
    // the site opted into active checks — never on a passive discovery.
    activeFormFill: isActiveScanEnabled(site),
  })
  logger.info(
    { discoveryId, engine: 'katana', seedPaths, maxMinutes, headerNames: site.headerNames },
    'katana start',
  )
  const result = await runCommand({
    label: `katana:${discoveryId}`,
    cmd: env.katana.bin,
    args,
    cwd: workDir,
    stdoutPath,
    stderrPath,
    timeoutMs: (maxMinutes + env.engineGraceMinutes) * 60_000,
    signal,
    logger,
  })
  if (result.aborted) throw new EngineError('katana aborted: server shutting down')
  const jsonl = existsSync(outputFile) ? await readFile(outputFile, 'utf8') : ''
  const { entries, invalidLines } = parseKatanaJsonl(jsonl)
  if (result.code !== 0 && !result.timedOut && entries.length === 0)
    throw new EngineError(
      `katana exited with code ${result.code ?? 'null'} signal ${result.signal ?? 'none'} and produced no output; check ${stderrPath}`,
      result.oomKilled ? OOM_RUNBOOK : undefined,
    )
  const { kept: real, dropped: katanaDropped } = dropKatanaArtifacts(entries)
  const { kept, dropped } = normalizeCrawledEntries(
    site,
    real,
    (e) => restoreLoopbackHost(e.url, env.localhostAlias, originalHost),
    { dedupeKeyOf: (e, url) => crawledUrlKey(e.method, url) },
  )
  const urls = kept.map(({ url, entry }) => ({
    url,
    method: entry.method,
    statusCode: entry.status,
    source: 'katana' as const,
  }))
  const warnings: string[] = []
  if (result.timedOut)
    warnings.push('katana was stopped by the engine timeout; its URL list may be partial')
  if (invalidLines > 0)
    warnings.push(`${invalidLines} unparsable line(s) in katana's output were ignored`)
  // Counts only: discovered URLs may carry query strings with sensitive values.
  logger.info(
    { discoveryId, engine: 'katana', rawCount: entries.length, urlCount: urls.length, dropped },
    'katana done',
  )
  return {
    urls,
    warnings,
    exitCode: result.code,
    signal: result.signal,
    meta: {
      maxDepth: KATANA_MAX_DEPTH,
      maxMinutes,
      rawCount: entries.length,
      urlCount: urls.length,
      dropped: { ...dropped, ...katanaDropped },
      durationSec: Math.round(result.durationMs / 1000),
      timedOut: result.timedOut,
      exitCode: result.code,
    },
  }
}
