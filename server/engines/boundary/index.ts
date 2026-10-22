import { isActiveScanEnabled } from '../../domain/activeScan'
import { parseExcludePatterns, pathMatchesAny } from '../../domain/excludePaths'
import { engineTimeBudget, timeBudgetEnv } from '../../domain/engineTimeBudget'
import { restoreLoopbackHost, rewriteLoopbackHost } from '../../domain/hostAlias'
import { expandNucleiTargets } from '../../domain/nucleiTargets'
import { emptyCounts } from '#shared/utils/severity'
import { EngineError, type EngineOutput, type EngineRunner, type NewFinding } from '../types'
import {
  judgeAcceptance,
  locateField,
  type ProbeRequest,
  type ProbeResponse,
  type Send,
} from './acceptance'
import { boundaryCases, type BoundaryCase } from './cases'
import { operationsFromOpenApi, operationsFromShapes, type BoundaryOperation } from './operations'

/** A response body is only compared, never stored; cap what is read of it. */
const MAX_RESPONSE_BYTES = 1_000_000

/** Reads at most MAX_RESPONSE_BYTES of the body and cancels the stream past
 * that, so a hostile or huge response is never buffered whole. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  await reader.cancel()
  return Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString('utf8')
}

const KIND_NAME: Record<BoundaryCase['kind'], string> = {
  'below-minimum': 'Server accepts a value below the documented minimum',
  'above-maximum': 'Server accepts a value above the documented maximum',
  'too-short': 'Server accepts a value shorter than the documented minimum length',
  'too-long': 'Server accepts a value longer than the documented maximum length',
  'not-in-enum': 'Server accepts a value outside the documented set of values',
  'wrong-type': 'Server accepts a value of the wrong type',
  empty: 'Server accepts an empty value for a required field',
}

const SOLUTION =
  'Validate every request body on the server against the same rules the UI and the API contract state (range, length, allowed values, type, required), and reject violations with a 4xx before anything is stored. Client-side limits are not a control.'

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })

function describeValue(v: unknown): string {
  const s = JSON.stringify(v)
  return s.length > 80 ? `${s.slice(0, 77)}…" (${s.length} chars)` : s
}

export const runBoundary: EngineRunner = async ({ scanId, site, env, logger, signal }) => {
  // Gate: boundary writes to the target, so it runs only under active checks.
  // Off → skip before building anything, recorded as skipped (not failed).
  if (!isActiveScanEnabled(site)) {
    logger.info({ scanId, engine: 'boundary' }, 'boundary skipped: active checks are off')
    return {
      findings: [],
      counts: emptyCounts(),
      warnings: [
        'boundary was skipped because active injection checks are off for this site — enable them to run the input-validation probe',
      ],
      exitCode: null,
      signal: null,
      meta: { skipped: true, reason: 'active-checks-off' },
      skipped: true,
    } satisfies EngineOutput
  }

  const started = Date.now()
  const alias = env.localhostAlias
  const timeBudget = engineTimeBudget('boundary', site, timeBudgetEnv(env), {
    activeScan: true,
    domXssProbe: false,
  })
  const deadline = started + timeBudget.totalMinutes * 60_000
  const warnings: string[] = []

  // Where the probe may send: the saved front/api origins and nothing else.
  const allowedOrigins = new Set(
    [site.frontBaseUrl, site.apiBaseUrl]
      .filter((u): u is string => !!u)
      .map((u) => new URL(u).origin),
  )
  const excludePatterns = parseExcludePatterns(site.excludePaths)
  const isExcludedPath = (pathname: string) => pathMatchesAny(pathname, excludePatterns)

  // Operations: the pasted OpenAPI's JSON-body writes (ranges known) plus the
  // approved write lines whose body shape was captured (types only).
  const apiBase = site.apiBaseUrl ?? site.frontBaseUrl
  const fromOpenApi = site.openapiJson
    ? operationsFromOpenApi(site.openapiJson, apiBase, isExcludedPath)
    : []
  if (site.openapiJson && fromOpenApi.length === 0)
    warnings.push(
      'the pasted OpenAPI document has no POST/PUT/PATCH operation with a JSON object body that boundary can use',
    )
  const openapiUrlOnly = !!site.openapiUrl && !site.openapiJson
  if (openapiUrlOnly)
    warnings.push(
      'the site has an OpenAPI URL but no pasted JSON — boundary does not fetch it, so only wrong-type and empty values are tried (paste the document as JSON to test ranges, lengths and allowed values)',
    )
  const { targets } = expandNucleiTargets(site)
  const fromShapes = operationsFromShapes(targets, site.requestShapes)
  const seen = new Set<string>()
  const operations: BoundaryOperation[] = []
  for (const op of [...fromOpenApi, ...fromShapes]) {
    const key = `${op.method} ${op.url}`
    if (seen.has(key)) continue // the contract (OpenAPI) wins over the captured shape
    seen.add(key)
    operations.push(op)
  }
  if (operations.length === 0)
    throw new EngineError(
      'boundary: no write operations to test — paste an OpenAPI document with JSON request bodies, or approve POST/PUT/PATCH target lines that have a captured body shape',
    )

  const planned = operations.flatMap((op) => boundaryCases(op.fields).map((c) => ({ op, c })))
  logger.info(
    {
      scanId,
      engine: 'boundary',
      operations: operations.length,
      casesPlanned: planned.length,
      maxRequests: env.boundary.maxRequests,
      headerNames: site.headerNames,
    },
    'boundary start',
  )

  let requestsSent = 0
  let responses = 0
  let errors = 0
  const timeoutMs = env.boundary.requestTimeoutSeconds * 1000
  const intervalMs = site.nucleiRateLimit > 0 ? Math.ceil(1000 / site.nucleiRateLimit) : 0

  // The single seam through which anything leaves the process. URLs here are
  // the saved (un-aliased) ones: the origin check runs on them, then the
  // loopback alias is applied for container networking.
  const send: Send = async (req: ProbeRequest): Promise<ProbeResponse> => {
    if (!allowedOrigins.has(new URL(req.url).origin))
      throw new EngineError(
        `boundary: refusing to send outside the saved origins (${new URL(req.url).origin})`,
      )
    if (requestsSent >= env.boundary.maxRequests)
      throw new RangeError('boundary request cap reached')
    requestsSent++
    const headers = new Headers()
    for (const h of site.headers) headers.set(h.name, h.value)
    if (req.contentType) headers.set('content-type', req.contentType)
    headers.set('accept', 'application/json')
    const res = await fetch(rewriteLoopbackHost(req.url, alias), {
      method: req.method,
      headers,
      body: req.body,
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
    responses++
    const location = res.headers.get('location')
    return {
      status: res.status,
      location: location
        ? restoreLoopbackHost(
            new URL(location, res.url).toString(),
            alias,
            new URL(req.url).hostname,
          )
        : null,
      body: await readCapped(res),
    }
  }

  const counts = emptyCounts()
  const findings: NewFinding[] = []
  const tally = { accepted: 0, rejected: 0, coerced: 0, unverifiable: 0 }
  const unverifiableReasons = new Map<string, number>()
  let truncated = false

  for (const { op, c } of planned) {
    if (signal.aborted) throw new EngineError('boundary aborted: server shutting down')
    if (Date.now() >= deadline || requestsSent >= env.boundary.maxRequests) {
      truncated = true
      break
    }
    try {
      const result = await judgeAcceptance(
        send,
        {
          method: op.method,
          url: op.url,
          body: JSON.stringify(c.body),
          contentType: 'application/json',
        },
        (doc) => locateField(doc, c.field, c.sent),
      )
      if (result.verdict === 'unverifiable') {
        tally.unverifiable++
        unverifiableReasons.set(result.reason, (unverifiableReasons.get(result.reason) ?? 0) + 1)
      } else {
        tally[result.verdict]++
      }
      if (result.verdict === 'accepted') {
        counts.medium++
        findings.push({
          engine: 'boundary',
          ruleId: `boundary:${c.kind}`,
          name: KIND_NAME[c.kind],
          severity: 'medium',
          url: op.url,
          method: op.method,
          param: c.field,
          evidence: `Sent ${c.field}=${describeValue(c.sent)} (${c.detail}); the server answered 2xx and the stored value read back from the ${result.readFrom === 'location' ? 'Location resource' : 'response body'} is identical.`,
          description: `${op.method} ${new URL(op.url).pathname} stored ${c.field} with a value that is ${c.detail}. Only the field under test was out of contract; the rest of the body was valid.`,
          solution: SOLUTION,
          reference: 'https://cwe.mitre.org/data/definitions/20.html',
          raw: { kind: c.kind, field: c.field, readFrom: result.readFrom },
        })
      }
    } catch (e) {
      if (e instanceof RangeError) {
        truncated = true
        break
      }
      if (signal.aborted)
        throw new EngineError('boundary aborted: server shutting down', undefined, { cause: e })
      if (e instanceof EngineError) throw e
      // One unreachable/slow endpoint must not end the run, but it is never
      // silent: it is counted and reported.
      errors++
      logger.warn(
        {
          scanId,
          engine: 'boundary',
          operation: `${op.method} ${new URL(op.url).pathname}`,
          field: c.field,
          kind: c.kind,
          err: e instanceof Error ? e.message : String(e),
        },
        'boundary request failed',
      )
    }
    if (intervalMs > 0) await sleep(intervalMs, signal)
  }

  if (responses === 0 && errors > 0)
    throw new EngineError(
      `boundary: every request failed (${errors}) — check the target is reachable from sakuda and SAKUDA_BOUNDARY_REQUEST_TIMEOUT_SECONDS`,
    )
  if (truncated)
    warnings.push(
      `boundary stopped early (${requestsSent}/${env.boundary.maxRequests} requests, ${timeBudget.totalMinutes} min budget); ${planned.length} case(s) were planned — raise SAKUDA_BOUNDARY_MAX_REQUESTS or SAKUDA_BOUNDARY_MAX_MINUTES to test the rest`,
    )
  if (tally.unverifiable > 0)
    warnings.push(
      `${tally.unverifiable} case(s) got a 2xx but the stored value could not be read back (${[...unverifiableReasons].map(([r, n]) => `${r}: ${n}`).join('; ')}) — they are not reported as findings`,
    )
  if (errors > 0)
    warnings.push(`${errors} request(s) failed (network error or timeout) and were skipped`)
  const skippedFields = operations.reduce((n, op) => n + op.skippedFields, 0)
  if (skippedFields > 0)
    warnings.push(
      `${skippedFields} body field(s) were not tested (nested objects, arrays or unsupported types)`,
    )

  logger.info(
    {
      scanId,
      engine: 'boundary',
      findings: findings.length,
      requestsSent,
      errors,
      ...tally,
      truncated,
    },
    'boundary done',
  )

  return {
    findings,
    counts,
    warnings,
    exitCode: 0,
    signal: null,
    meta: {
      operations: operations.length,
      openapiOperations: fromOpenApi.length,
      shapeOperations: fromShapes.length,
      openapiUrlOnly,
      casesPlanned: planned.length,
      requestsSent,
      maxRequests: env.boundary.maxRequests,
      ...tally,
      errors,
      truncated,
      timeBudget,
      durationSec: Math.round((Date.now() - started) / 1000),
    },
  } satisfies EngineOutput
}
