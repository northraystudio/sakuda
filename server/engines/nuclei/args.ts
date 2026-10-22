import type { OastConfig } from '../../config/env'
import { headersConfigArgs } from '../headersConfig'
import { oastArgs } from './oast'

export interface NucleiArgsInput {
  targetsFile: string
  templatesDir: string
  outputFile: string
  rateLimit: number
  concurrency: number
  tags: string[]
  /** Path of the 0600 headers config (`engines/headersConfig`), or null
   * when the site has no headers — the values never go on argv (#95). */
  headersConfigFile: string | null
  /** interactsh setting (#35): `-ni` when off, `-iserver` when self-hosted. */
  oast: OastConfig
  /** `-exclude-tags` value; defaults to all three risk tags. The caller
   * passes a shorter list only when a site opted a risk group back in
   * (see `domain/activeScan` `riskExcludeTags`). */
  excludeTags?: string[]
}

/**
 * Every phase passes `-no-mhe`: nuclei's default `-max-host-error 30` drops a
 * host from the scan after 30 errors, which is a sane guard when scanning
 * thousands of hosts but fatal here — a site's targets share one or two
 * hosts, so one skip silently ends the whole phase at a few percent
 * coverage (#82). Slow or error-prone targets are the norm for a DAST run.
 */
export const NUCLEI_NO_HOST_ERROR_SKIP = '-no-mhe'

export const NUCLEI_BASE_TAGS = ['xss', 'injection', 'sqli', 'ssrf', 'lfi', 'exposure', 'misconfig']

/** Risk-template tags nuclei excludes by default; a site can opt individual
 * ones back in under `allowMutatingRequests` (see `domain/activeScan`). */
export const NUCLEI_RISK_EXCLUDE_TAGS = ['dos', 'fuzz', 'intrusive']

/**
 * High-signal signature categories run as a dedicated *priority* pass before
 * the full `http` tree (#3). The full tree is ~5022 templates and, against a
 * rate-limited target, only a fraction of its planned requests run before the
 * engine deadline — exposed metrics / config / misconfiguration detections
 * (e.g. `prometheus-metrics`, medium) were routinely in the unrun majority. A
 * small pass restricted to these tags exercises them first, within budget; the
 * full pass then excludes them so nothing is scanned twice. Non-mutating
 * detection templates, so no risk-opt-in gate applies.
 */
export const NUCLEI_PRIORITY_SIGNATURE_TAGS = ['exposure', 'config', 'misconfig']

/** The exclude-tags for the full signature pass: the risk groups plus the
 * priority tags already covered by the priority pass, so the two passes never
 * run the same template twice. Pure. */
export function fullSignatureExcludeTags(riskExcludeTags: string[]): string[] {
  return [...new Set([...riskExcludeTags, ...NUCLEI_PRIORITY_SIGNATURE_TAGS])]
}

export function nucleiTagsFor(hasHeaders: boolean): string[] {
  return hasHeaders ? [...NUCLEI_BASE_TAGS, 'auth-bypass'] : [...NUCLEI_BASE_TAGS]
}

/**
 * Args for the signature phase: the `http` template tree against the GET
 * target list, in both passive and active mode. Never `-dast` — nuclei
 * treats that flag as "run DAST templates only", so passing it here would
 * silently drop every signature template (#65); the DAST tree gets its own
 * run via {@link buildNucleiDastArgs}. Active mode only changes the tag
 * lists (risk groups opted back in), which apply to the signature tree too.
 */
export function buildNucleiArgs(i: NucleiArgsInput): string[] {
  return [
    '-l',
    i.targetsFile,
    '-t',
    i.templatesDir,
    '-tags',
    i.tags.join(','),
    '-severity',
    'critical,high,medium',
    '-exclude-tags',
    (i.excludeTags ?? NUCLEI_RISK_EXCLUDE_TAGS).join(','),
    '-rate-limit',
    String(i.rateLimit),
    '-c',
    String(i.concurrency),
    '-jsonl',
    '-o',
    i.outputFile,
    '-stats-json',
    '-si',
    '5',
    '-duc',
    NUCLEI_NO_HOST_ERROR_SKIP,
    '-nc',
    '-omit-raw',
    ...headersConfigArgs(i.headersConfigFile),
    ...oastArgs(i.oast),
  ]
}

export interface NucleiDastArgsInput {
  targetsFile: string
  /** DAST (fuzzing) template tree only; the signature tree has its own run. */
  dastTemplatesDir: string
  outputFile: string
  rateLimit: number
  concurrency: number
  /** Same lists as the signature phase (risk groups included), so a risk
   * opt-in gates the DAST templates exactly as it did before the split. */
  tags: string[]
  excludeTags: string[]
  /** Path of the 0600 headers config (`engines/headersConfig`), or null
   * when the site has no headers — the values never go on argv (#95). */
  headersConfigFile: string | null
  /** interactsh setting (#35): `-ni` when off, `-iserver` when self-hosted. */
  oast: OastConfig
}

/**
 * Args for the active GET DAST phase (#65): the same target list as the
 * signature phase, but only the DAST tree with `-dast`, which is what makes
 * nuclei execute fuzzing templates at all. Tag filters are shared with the
 * signature phase so the template set equals what the single active run
 * used to execute before the split.
 */
export function buildNucleiDastArgs(i: NucleiDastArgsInput): string[] {
  return [
    '-l',
    i.targetsFile,
    '-t',
    i.dastTemplatesDir,
    '-dast',
    '-tags',
    i.tags.join(','),
    '-severity',
    'critical,high,medium',
    '-exclude-tags',
    i.excludeTags.join(','),
    '-rate-limit',
    String(i.rateLimit),
    '-c',
    String(i.concurrency),
    '-jsonl',
    '-o',
    i.outputFile,
    '-stats-json',
    '-si',
    '5',
    '-duc',
    NUCLEI_NO_HOST_ERROR_SKIP,
    '-nc',
    '-omit-raw',
    ...headersConfigArgs(i.headersConfigFile),
    ...oastArgs(i.oast),
  ]
}

export interface NucleiOpenapiArgsInput {
  /** The generated OpenAPI document, imported with `-im openapi`. */
  openapiFile: string
  /** DAST (fuzzing) template tree only — the OpenAPI phase is exactly the
   * fuzzing phase, so it never loads the signature `http` tree. */
  dastTemplatesDir: string
  outputFile: string
  rateLimit: number
  concurrency: number
  /** Path of the 0600 headers config (`engines/headersConfig`), or null
   * when the site has no headers — the values never go on argv (#95). */
  headersConfigFile: string | null
  /** interactsh setting (#35): `-ni` when off, `-iserver` when self-hosted. */
  oast: OastConfig
}

/**
 * Args for the non-GET OpenAPI DAST phase (Epic #41 PR3). Unlike
 * {@link buildNucleiArgs} it imports an OpenAPI document (`-im openapi`),
 * loads only the DAST tree, and applies no tag filter — the DAST templates
 * are the whole point of this phase. Same `-omit-raw` / severity / output
 * discipline as the list phase.
 */
export function buildNucleiOpenapiArgs(i: NucleiOpenapiArgsInput): string[] {
  return [
    '-l',
    i.openapiFile,
    '-im',
    'openapi',
    '-t',
    i.dastTemplatesDir,
    '-dast',
    '-severity',
    'critical,high,medium',
    '-rate-limit',
    String(i.rateLimit),
    '-c',
    String(i.concurrency),
    '-jsonl',
    '-o',
    i.outputFile,
    '-stats-json',
    '-si',
    '5',
    '-duc',
    NUCLEI_NO_HOST_ERROR_SKIP,
    '-nc',
    '-omit-raw',
    ...headersConfigArgs(i.headersConfigFile),
    ...oastArgs(i.oast),
  ]
}
