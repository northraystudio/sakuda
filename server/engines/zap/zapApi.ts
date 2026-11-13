import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isActiveScanEnabled, seedEmptyQueryValues } from '../../domain/activeScan'
import {
  engineTimeBudget,
  timeBudgetEnv,
  ZAP_PASSIVE_MAX_MINUTES,
} from '../../domain/engineTimeBudget'
import { escapeRegex, zapExcludeRegexes } from '../../domain/excludePaths'
import { restoreLoopbackHost, rewriteLoopbackHost } from '../../domain/hostAlias'
import { buildNonGetOpenApiDocs } from '../../domain/openapiGen'
import { expandNucleiTargets } from '../../domain/nucleiTargets'
import { EngineError, OOM_RUNBOOK, type EngineRunner } from '../types'
import { buildZapApiPlan, planToYaml, ZAP_REPORT_JSON } from './plan'
import { buildReplacerConf } from './replacer'
import { fetchOpenapiDoc } from './openapiFetch'
import { normalizeZapReport, parseZapReport } from './report'
import { runZap, zapPath } from './runZap'

/** The document fetched from the site's OpenAPI URL. ZAP reads JSON or YAML
 * whatever the extension, so one name fits both. */
const OPENAPI_URL_FILE = 'openapi-url.json'

export const runZapApi: EngineRunner = async ({ scanId, site, workDir, env, logger, signal }) => {
  const alias = env.zap.localhostAlias
  const targetBase = site.apiBaseUrl ?? site.frontBaseUrl
  const originalHost = new URL(targetBase).hostname
  const aliasedBase = rewriteLoopbackHost(targetBase + '/', alias).replace(/\/$/, '')

  // One `openapi` import job per source: the user's pasted/URL doc (if any) and
  // sakuda's generated non-GET doc (#73). The generated doc is written 0600 and
  // deleted after the run (secretFiles), same discipline as nuclei's.
  const openapiSources: Array<{ apiFile: string }> = []
  const secretFiles: Record<string, string> = {}
  const sourceLabels: string[] = []

  if (site.openapiJson) {
    await mkdir(workDir, { recursive: true })
    await writeFile(join(workDir, 'openapi.json'), site.openapiJson)
    openapiSources.push({ apiFile: zapPath(env, workDir, 'openapi.json') })
    sourceLabels.push('pasted')
  } else if (site.openapiUrl) {
    // sakuda fetches the document itself instead of handing ZAP the URL: ZAP
    // follows a redirect to any host, and fetchOpenapiDoc checks every hop
    // against the site's origins (#57). The fetched document may be private,
    // so it goes through secretFiles like the generated docs.
    secretFiles[OPENAPI_URL_FILE] = await fetchOpenapiDoc({
      url: site.openapiUrl,
      allowedOrigins: [site.frontBaseUrl, site.apiBaseUrl, ...site.openapiAllowedOrigins].filter(
        (u): u is string => u !== null,
      ),
      headers: site.headers,
      localhostAlias: env.localhostAlias,
      signal,
    })
    openapiSources.push({ apiFile: zapPath(env, workDir, OPENAPI_URL_FILE) })
    sourceLabels.push('url')
  }

  // Generated doc: approved non-GET body shapes become a requestBody with
  // synthetic values. Active-checks only (the doc drives mutating requests),
  // limited to the operations whose origin this scan targets.
  let generatedDocCount = 0
  if (isActiveScanEnabled(site)) {
    const { targets } = expandNucleiTargets(site)
    const nonGet = targets.filter((t) => t.method !== 'GET' && !t.url.includes('#'))
    const seedOne = (u: string) => seedEmptyQueryValues([u])[0]!
    const { docs } = buildNonGetOpenApiDocs(
      nonGet,
      (u) => rewriteLoopbackHost(u, alias),
      seedOne,
      site.requestShapes,
    )
    const baseOrigin = new URL(aliasedBase).origin
    docs
      .filter((d) => d.origin === baseOrigin)
      .forEach((d, i) => {
        const name = `generated-openapi-${i}.json`
        secretFiles[name] = JSON.stringify(d.doc)
        openapiSources.push({ apiFile: zapPath(env, workDir, name) })
        generatedDocCount++
      })
  }

  if (openapiSources.length === 0)
    throw new EngineError(
      'zap-api has no OpenAPI source: set openapiUrl or openapiJson, or approve non-GET targets with captured body shapes and turn on active injection checks',
    )

  const openapiSource =
    sourceLabels.length > 0 && generatedDocCount > 0
      ? `${sourceLabels[0]}+generated`
      : generatedDocCount > 0
        ? 'generated'
        : (sourceLabels[0] ?? 'none')

  const excludeRegexes = zapExcludeRegexes(site.excludePaths)
  const timeBudget = engineTimeBudget('zap-api', site, timeBudgetEnv(env), {
    activeScan: true,
    domXssProbe: false,
  })
  const plan = buildZapApiPlan({
    context: {
      name: 'sakuda',
      urls: [aliasedBase + '/'],
      includePaths: [`^${escapeRegex(aliasedBase)}(/.*)?$`],
      excludePaths: excludeRegexes,
    },
    openapiSources,
    targetUrl: aliasedBase,
    maxScanMinutes: site.zapApiMaxMinutes,
    passiveMaxMinutes: ZAP_PASSIVE_MAX_MINUTES,
    reportDir: zapPath(env, workDir, '') + '/',
  })
  logger.info(
    {
      scanId,
      engine: 'zap-api',
      targetUrl: targetBase,
      openapiSource,
      maxScanMinutes: site.zapApiMaxMinutes,
      headerNames: site.headerNames,
    },
    'zap-api start',
  )
  // The budget is the one source for the process timeout (#84).
  const timeoutMs = timeBudget.totalMinutes * 60_000
  const run = await runZap({
    label: `zap-api:${scanId}`,
    env,
    workDir,
    planYaml: planToYaml(plan),
    replacerConf: site.headers.length ? buildReplacerConf(site.headers) : null,
    ...(Object.keys(secretFiles).length > 0 ? { secretFiles } : {}),
    timeoutMs,
    signal,
    logger,
  })
  if (run.result.aborted) throw new EngineError('zap-api aborted: server shutting down')
  if (run.reportText === null)
    throw new EngineError(
      `zap-api produced no ${ZAP_REPORT_JSON} (exit ${run.result.code ?? 'null'}, signal ${run.result.signal ?? 'none'}${run.result.timedOut ? ', timed out' : ''}); see ${join(workDir, 'stdout.log')}`,
      run.result.oomKilled ? OOM_RUNBOOK : undefined,
    )
  const n = normalizeZapReport(parseZapReport(run.reportText), 'zap-api', (u) =>
    restoreLoopbackHost(u, alias, originalHost),
  )
  const warnings: string[] = []
  if (n.authFailureCount > 0)
    warnings.push(`${n.authFailureCount} request(s) got 401/403 — headers may be expired`)
  if (n.totalAlerts === 0)
    warnings.push(
      'ZAP returned zero alerts of any severity — verify the target was reachable before trusting this result',
    )
  if (run.result.timedOut)
    warnings.push('ZAP was stopped by the engine timeout; the report may be partial')
  return {
    findings: n.findings,
    counts: n.counts,
    warnings,
    exitCode: run.result.code,
    signal: run.result.signal,
    meta: {
      zapVersion: n.zapVersion,
      targetUrl: targetBase,
      openapiSource,
      generatedDocCount,
      maxScanMinutes: site.zapApiMaxMinutes,
      timeBudget,
      authFailureCount: n.authFailureCount,
      alertCounts: n.alertCounts,
      reachedUrlCount: n.reachedUrls.length,
      excludeRegexes,
      durationSec: Math.round(run.result.durationMs / 1000),
      timedOut: run.result.timedOut,
    },
  }
}
