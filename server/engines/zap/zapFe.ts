import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isActiveScanEnabled, isSafeMethod, seedEmptyQueryValues } from '../../domain/activeScan'
import { zapScopeContext } from '../../domain/crawlScope'
import { buildReachRecord } from '../../domain/diff'
import {
  DOM_XSS_PROBE_BUDGET_MINUTES,
  engineTimeBudget,
  timeBudgetEnv,
  ZAP_PASSIVE_MAX_MINUTES,
} from '../../domain/engineTimeBudget'
import { zapExcludeRegexes } from '../../domain/excludePaths'
import { joinUrl, restoreLoopbackHost, rewriteLoopbackHost } from '../../domain/hostAlias'
import {
  countSkippedMethods,
  expandNucleiTargets,
  zapFeHashRouteTargets,
  zapFeRequestTargets,
} from '../../domain/nucleiTargets'
import type { Logger } from '../../lib/logger'
import { EngineError, OOM_RUNBOOK, type EngineRunner } from '../types'
import { buildZapFePlan, planToYaml, ZAP_REPORT_JSON } from './plan'
import { buildFirefoxPrefsConfig } from './firefoxPrefs'
import { buildReplacerConf } from './replacer'
import { normalizeZapReport, parseZapReport } from './report'
import { runZap, zapPath } from './runZap'
import {
  buildSiteTreeDumpScript,
  parseSiteTreeDump,
  SITE_TREE_DUMP_ENGINE,
  SITE_TREE_DUMP_OUTPUT_FILE,
  SITE_TREE_DUMP_SCRIPT_FILE,
  SITE_TREE_DUMP_SCRIPT_NAME,
} from './siteTreeDump'
import { isSeedAccessFailure, parseJobAccessFailures, seedPathReached } from './spiderReach'
import { resolveDiscoverySeeds } from '#shared/utils/seedPaths'
import { crawlScopePrefixes } from '#shared/utils/crawlScope'
import {
  BROWSER_STORAGE_SCRIPT_ENGINE,
  BROWSER_STORAGE_SCRIPT_FILE,
  BROWSER_STORAGE_SCRIPT_NAME,
  buildBrowserStorageScript,
} from './browserStorageScript'
import {
  buildDomXssProbeScript,
  parseDomXssProbeSummary,
  DOM_XSS_PROBE_OUTPUT_FILE,
  DOM_XSS_PROBE_SCRIPT_ENGINE,
  DOM_XSS_PROBE_SCRIPT_FILE,
  DOM_XSS_PROBE_SCRIPT_NAME,
} from './domXssProbeScript'

/** Per-navigation settle for the DOM XSS probe; its overall budget lives in
 * domain/engineTimeBudget so the page can show it. */
const DOM_XSS_PROBE_SETTLE_MS = 1_500

export const runZapFe: EngineRunner = async ({ scanId, site, workDir, env, logger, signal }) => {
  const alias = env.zap.localhostAlias
  const originalHost = new URL(site.frontBaseUrl).hostname
  const base = rewriteLoopbackHost(site.frontBaseUrl + '/', alias).replace(/\/$/, '')
  // The crawl starts are the site's step-4 list — the same seeds discovery
  // uses (one Ajax spider run each); the first is where the traditional
  // spider starts and what the session check looks for.
  const seedPaths = resolveDiscoverySeeds(site)
  const seedUrls = seedPaths.map((p) => joinUrl(base, p))
  const seedPath = seedPaths[0] ?? site.zapFeSeedPath
  const seedUrl = seedUrls[0] ?? joinUrl(base, seedPath)
  const excludeRegexes = zapExcludeRegexes(site.excludePaths)
  const hasBrowserStorage = site.browserStorage.length > 0
  // The single source of truth for "may this scan attack the target" —
  // never decided here, only read (see domain/activeScan). The cap reuses the
  // site's ZAP API limit: it is the one active-scan budget the site defines.
  const activeScan = isActiveScanEnabled(site)
  const activeScanMaxMinutes = activeScan ? site.zapApiMaxMinutes : 0
  const seedOne = (u: string) => seedEmptyQueryValues([u])[0]!
  // Expand the saved targets once; the requestor, the DOM probe and the skip
  // telemetry all read this one result.
  const expanded = expandNucleiTargets(site)
  // Saved front-base targets the spiders may never reach get requested up
  // front (with their own method) so the scans see them. A safe method
  // (GET/HEAD/OPTIONS) is always requested; a mutating one only under active
  // checks (`isActiveScanEnabled`), so a passive run stays read-only. An
  // active run seeds empty query values (`?q=` → `?q=1`) exactly as nuclei's
  // transient targets file does — the saved list is untouched.
  const frontTargets = zapFeRequestTargets(expanded)
  const dispatched = frontTargets.filter((t) => isSafeMethod(t.method) || activeScan)
  // Seeding can make two distinct saved lines the same request (`/s?q=` and
  // `/s?q=1`); a mutating request must not be sent twice for that, so the
  // requestor list is keyed on method + final URL.
  const requestTargets = [
    ...new Map(
      dispatched.map((t) => {
        const url = rewriteLoopbackHost(activeScan ? seedOne(t.url) : t.url, alias)
        return [`${t.method} ${url}`, { method: t.method, url }] as const
      }),
    ).values(),
  ]
  // skippedMethods = front-base non-GET targets the requestor did not send:
  // mutating ones on a passive run, plus any non-GET hash route (the DOM probe
  // is GET-only, so a non-GET hash route reaches no engine). Counts only.
  const dispatchedKeys = new Set(dispatched.map((t) => `${t.method} ${t.url}`))
  const skippedMethods = countSkippedMethods(
    expanded.targets.filter(
      (t) => t.base === 'front' && !dispatchedKeys.has(`${t.method} ${t.url}`),
    ),
  )
  // Hash-route targets (`/#/search?q=`) can only be tested from a real
  // browser (the fragment never reaches ZAP's proxy), and only when the site
  // opted into active checks. The probe injects into the empty query value
  // itself, so unlike requestUrls these are not seeded here.
  const hashRoutes = activeScan
    ? zapFeHashRouteTargets(expanded).map((u) => rewriteLoopbackHost(u, alias))
    : []
  const runDomXssProbe = hashRoutes.length > 0
  // The front origin whole, or — with a crawl scope — its prefixes, the seed
  // itself and the `apiBaseUrl` subtree (see domain/crawlScope): the same
  // rule as discovery, so a same-origin `/api` next to a scoped `/app` stays
  // reachable. Unrestricted, the API is left out as it always was here — the
  // plan must not change for sites that set no scope.
  const scopePrefixes = crawlScopePrefixes(site.crawlScopePaths)
  const scope = zapScopeContext({
    seedUrls,
    front: base,
    api:
      scopePrefixes.length > 0 && site.apiBaseUrl
        ? rewriteLoopbackHost(site.apiBaseUrl + '/', alias).replace(/\/$/, '')
        : null,
    prefixes: scopePrefixes,
  })
  const plan = buildZapFePlan({
    context: { name: 'sakuda', ...scope, excludePaths: excludeRegexes },
    seedUrls,
    ...(hasBrowserStorage
      ? {
          browserScript: {
            file: zapPath(env, workDir, BROWSER_STORAGE_SCRIPT_FILE),
            name: BROWSER_STORAGE_SCRIPT_NAME,
            engine: BROWSER_STORAGE_SCRIPT_ENGINE,
          },
        }
      : {}),
    spiderMaxMinutes: site.zapFeSpiderMaxMinutes,
    ajaxMaxMinutes: site.zapFeSpiderMaxMinutes,
    passiveMaxMinutes: ZAP_PASSIVE_MAX_MINUTES,
    ...(activeScan ? { activeScan: { maxScanMinutes: activeScanMaxMinutes } } : {}),
    requestTargets,
    ...(runDomXssProbe
      ? {
          domXssProbe: {
            file: zapPath(env, workDir, DOM_XSS_PROBE_SCRIPT_FILE),
            name: DOM_XSS_PROBE_SCRIPT_NAME,
            engine: DOM_XSS_PROBE_SCRIPT_ENGINE,
          },
        }
      : {}),
    // What the spiders actually reached, for the seed check below — the
    // report's alert URIs only list pages that raised an alert.
    siteTreeDump: {
      file: zapPath(env, workDir, SITE_TREE_DUMP_SCRIPT_FILE),
      name: SITE_TREE_DUMP_SCRIPT_NAME,
      engine: SITE_TREE_DUMP_ENGINE,
    },
    reportDir: zapPath(env, workDir, '') + '/',
  })
  logger.info(
    {
      scanId,
      engine: 'zap-fe',
      seedUrls: seedPaths.map((p) => joinUrl(site.frontBaseUrl, p)),
      spiderMaxMinutes: site.zapFeSpiderMaxMinutes,
      activeScan,
      activeScanMaxMinutes,
      targetUrlCount: requestTargets.length,
      hashRouteCount: hashRoutes.length,
      headerNames: site.headerNames,
      browserStorageNames: site.browserStorageNames,
    },
    'zap-fe start',
  )
  // The budget is the one source for the process timeout (#84).
  const timeBudget = engineTimeBudget('zap-fe', site, timeBudgetEnv(env), {
    activeScan,
    domXssProbe: runDomXssProbe,
  })
  const timeoutMs = timeBudget.totalMinutes * 60_000
  const run = await runZap({
    label: `zap-fe:${scanId}`,
    env,
    workDir,
    planYaml: planToYaml(plan),
    replacerConf: site.headers.length ? buildReplacerConf(site.headers) : null,
    config: buildFirefoxPrefsConfig(alias),
    extraFiles: {
      [SITE_TREE_DUMP_SCRIPT_FILE]: buildSiteTreeDumpScript(
        zapPath(env, workDir, SITE_TREE_DUMP_OUTPUT_FILE),
      ),
      ...(runDomXssProbe
        ? {
            [DOM_XSS_PROBE_SCRIPT_FILE]: buildDomXssProbeScript({
              routes: hashRoutes,
              origin: base,
              outputPath: zapPath(env, workDir, DOM_XSS_PROBE_OUTPUT_FILE),
              budgetMs: DOM_XSS_PROBE_BUDGET_MINUTES * 60_000,
              settleMs: DOM_XSS_PROBE_SETTLE_MS,
            }),
          }
        : {}),
    },
    ...(hasBrowserStorage
      ? {
          secretFiles: {
            [BROWSER_STORAGE_SCRIPT_FILE]: buildBrowserStorageScript(site.browserStorage, [base]),
          },
        }
      : {}),
    timeoutMs,
    signal,
    logger,
  })
  if (run.result.aborted) throw new EngineError('zap-fe aborted: server shutting down')
  if (run.reportText === null)
    throw new EngineError(
      `zap-fe produced no ${ZAP_REPORT_JSON} (exit ${run.result.code ?? 'null'}, signal ${run.result.signal ?? 'none'}${run.result.timedOut ? ', timed out' : ''}); see ${join(workDir, 'stdout.log')}`,
      run.result.oomKilled ? OOM_RUNBOOK : undefined,
    )
  const n = normalizeZapReport(parseZapReport(run.reportText), 'zap-fe', (u) =>
    restoreLoopbackHost(u, alias, originalHost),
  )
  // The DOM XSS probe raises its findings as ZAP alerts (already in `n`); its
  // summary file only tells us whether the wall-clock budget cut it short.
  const domXssSummary = runDomXssProbe ? await readDomXssProbeSummary(workDir) : null
  // Reachability comes from ZAP's own output, never from the alerts: the
  // spider's access failure on the seed (stderr), and the site tree dumped
  // right after the spiders (what they really requested).
  const seedFailure = parseJobAccessFailures(await readWorkFile(workDir, 'stderr.log')).find((f) =>
    isSeedAccessFailure(f, seedUrl),
  )
  const crawledUrls = await readCrawledUrls(workDir, logger, (u) =>
    restoreLoopbackHost(u, alias, originalHost),
  )
  // A URL that produced an alert was requested too, even when the dump (taken
  // right after the spiders) predates it.
  const reach = crawledUrls !== null ? buildReachRecord([...crawledUrls, ...n.reachedUrls]) : null
  const warnings: string[] = []
  if (domXssSummary?.truncated)
    warnings.push(
      `DOM XSS probe hit its ${DOM_XSS_PROBE_BUDGET_MINUTES}-minute budget before covering every hash route — some routes were not tested`,
    )
  if (seedFailure)
    warnings.push(
      `spider could not reach the seed URL ${seedPath} (${seedFailure.reason}) — verify the target is up and reachable from the ZAP container (host alias / network) before checking the site headers`,
    )
  else if (
    site.headers.length > 0 &&
    crawledUrls !== null &&
    seedPathReached(seedPath, crawledUrls) === false
  )
    warnings.push(
      `seed path ${seedPath} was not among the URLs the spider crawled — the session may not have been accepted; check the site headers`,
    )
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
      seedUrls: seedPaths.map((p) => joinUrl(site.frontBaseUrl, p)),
      spider: 'traditional + ajax',
      browserStorage: site.browserStorageNames.map((n) => `${n.kind}:${n.name}`),
      spiderMaxMinutes: site.zapFeSpiderMaxMinutes,
      activeScan,
      ...(activeScan ? { activeScanMaxMinutes } : {}),
      timeBudget,
      targetUrlCount: requestTargets.length,
      hashRouteCount: hashRoutes.length,
      ...(Object.keys(skippedMethods).length > 0 ? { skippedMethods } : {}),
      ...(domXssSummary
        ? { domXssProbed: domXssSummary.probed, domXssTruncated: domXssSummary.truncated }
        : {}),
      reachedUrlCount: n.reachedUrls.length,
      reachedUrls: n.reachedUrls.slice(0, 200),
      ...(crawledUrls !== null ? { crawledUrlCount: crawledUrls.length } : {}),
      // What this run requested, so a later diff can tell "fixed" from "not
      // looked at" (#89). Scheme, host and path only — no query values.
      ...(reach !== null
        ? {
            crawledUrls: reach.urls,
            ...(reach.truncated ? { crawledUrlsTruncated: true } : {}),
          }
        : {}),
      authFailureCount: n.authFailureCount,
      alertCounts: n.alertCounts,
      excludeRegexes,
      durationSec: Math.round(run.result.durationMs / 1000),
      timedOut: run.result.timedOut,
    },
  }
}

/** Reads the DOM XSS probe's `{probed,hits,truncated}` summary from the work
 * dir; null if the script never wrote it (e.g. it crashed before the run).
 * The summary is optional telemetry, so a read error (the file vanished
 * between the check and the read, permissions) degrades to null rather than
 * failing a scan that has already finished. */
async function readDomXssProbeSummary(workDir: string) {
  const path = join(workDir, DOM_XSS_PROBE_OUTPUT_FILE)
  if (!existsSync(path)) return null
  try {
    return parseDomXssProbeSummary(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** A file ZAP's run left in the work dir, or '' when it never wrote one. */
async function readWorkFile(workDir: string, name: string): Promise<string> {
  const path = join(workDir, name)
  return existsSync(path) ? readFile(path, 'utf8') : ''
}

/** The URLs the spiders requested, from the site-tree dump (un-aliased),
 * or null when the dump cannot be trusted: missing (the script job did not
 * run, e.g. ZAP died mid-plan) or yielding no entry while some lines were
 * unparsable (a corrupt dump, which must not read as "the spider crawled
 * nothing"). The dump is diagnostic telemetry next to the real report, so
 * either case is logged and the seed check is skipped, not failed. */
async function readCrawledUrls(
  workDir: string,
  logger: Logger,
  unalias: (u: string) => string,
): Promise<string[] | null> {
  const text = await readWorkFile(workDir, SITE_TREE_DUMP_OUTPUT_FILE)
  if (text === '') {
    logger.warn(
      { workDir, file: SITE_TREE_DUMP_OUTPUT_FILE },
      'zap-fe site-tree dump missing; seed reachability not checked',
    )
    return null
  }
  const dump = parseSiteTreeDump(text)
  if (dump.entries.length === 0 && dump.invalidLines > 0) {
    logger.warn(
      { workDir, file: SITE_TREE_DUMP_OUTPUT_FILE, invalidLines: dump.invalidLines },
      'zap-fe site-tree dump has no readable entry; seed reachability not checked',
    )
    return null
  }
  return dump.entries.map((e) => unalias(e.url))
}
