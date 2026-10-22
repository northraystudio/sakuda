import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { hostnameOf } from '../lib/loopback'

export class EnvError extends Error {
  constructor(...args: ConstructorParameters<typeof Error>) {
    super(...args)
    this.name = 'EnvError'
  }
}

/**
 * `runCommand`/`runZap` spawn with `cwd: <per-scan workDir>`, so Node
 * resolves a relative command containing a path separator (e.g.
 * `./scripts/zap-docker.sh`) against *that* directory, not the process's
 * cwd — it can never be found. Resolve such values against
 * `process.cwd()` at parse time instead. A bare name with no separator
 * (e.g. `zap.sh`, `nuclei`) is left untouched for a `PATH` lookup, and an
 * already-absolute path is left untouched too.
 */
function resolveExecutablePath(value: string): string {
  if (!value.includes('/')) return value
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

function isBase64Key32(s: string): boolean {
  const buf = Buffer.from(s, 'base64')
  return buf.length === 32 && buf.toString('base64') === s
}

const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
)

/** `404,410` → `[404, 410]`; empty/unset → `[]` (the probe annotates only).
 * Only a 4xx other than 405/429 may be listed: a 405 (method refused), 429
 * (throttled), 5xx (server down) or 2xx/3xx is never evidence that nuclei
 * would find nothing there, so listing one is a config mistake, not an
 * opt-in — fail fast (#91). */
const pruneStatusCodes = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c !== '')
      : v,
  z
    .array(
      z.coerce
        .number()
        .int()
        .min(400)
        .max(499)
        .refine((c) => c !== 405 && c !== 429, 'must not be 405 or 429'),
    )
    .default([]),
)

/** `sakuda.lan, 192.168.1.5` → `['sakuda.lan', '192.168.1.5']`; empty/unset
 * → `[]` (loopback only). Each entry must be a bare hostname exactly as the
 * `/api/**` guard compares it — no port, path or wildcard — so a typo fails
 * at startup instead of silently allowing nothing, or something else (#22). */
const allowedHosts = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((h) => h.trim())
          .filter((h) => h !== '')
      : v,
  z
    .array(
      z
        .string()
        .refine(
          (h) => !h.includes('*') && hostnameOf(h, false) === h.toLowerCase(),
          'must be a bare hostname (no port, path or wildcard; IPv6 in [brackets], IDN in punycode)',
        )
        .transform((h) => h.toLowerCase()),
    )
    .default([]),
)

/**
 * Where nuclei's interactsh client registers for out-of-band callbacks
 * (#35): `public` = nuclei's own default list of ProjectDiscovery servers
 * (`oast.pro`, …), `off` = `-ni` (OAST templates excluded, nothing leaves
 * the scan), or a self-hosted interactsh server.
 */
export type OastConfig =
  | { mode: 'public' }
  | { mode: 'off' }
  | { mode: 'self-hosted'; serverUrl: string; token: string | undefined }

const OAST_ERROR =
  'must be public, off, or the http(s) URL of a self-hosted interactsh server (no credentials in the URL; use SAKUDA_OAST_TOKEN)'

/** `public` (default, also when empty) | `off` | `http(s)://host[:port]`. A
 * URL with userinfo is refused: it would end up on nuclei's argv. */
const oastServer = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v),
  z
    .union(
      [
        z.enum(['public', 'off']),
        // zod still runs a refinement after a failed `.url()` check, so guard
        // the parse instead of letting `new URL` throw.
        z.url({ protocol: /^https?$/ }).refine((u) => {
          if (!URL.canParse(u)) return false
          const parsed = new URL(u)
          return parsed.username === '' && parsed.password === ''
        }),
      ],
      { error: OAST_ERROR },
    )
    .default('public'),
)

const EnvObject = z.object({
  SAKUDA_ENCRYPTION_KEY: z
    .string({
      error: 'SAKUDA_ENCRYPTION_KEY is required (base64 of 32 random bytes; run `pnpm keygen`)',
    })
    .refine(isBase64Key32, 'SAKUDA_ENCRYPTION_KEY must be canonical base64 of exactly 32 bytes'),
  SAKUDA_DATA_DIR: z.string().default('./data'),
  SAKUDA_MIGRATIONS_DIR: z.string().default('./server/db/migrations'),
  SAKUDA_NUCLEI_BIN: z.string().default('nuclei'),
  SAKUDA_NUCLEI_TEMPLATES: z.string().default('/opt/nuclei-templates/http'),
  // Non-empty: an explicit empty value would make `dastTemplatesDir` falsy and
  // silently drop `-t <dir>`/`-dast`, so an opted-in active scan would revert to
  // passive with no error. Fail fast at startup instead.
  SAKUDA_NUCLEI_DAST_TEMPLATES: z
    .string()
    .trim()
    .min(1, 'SAKUDA_NUCLEI_DAST_TEMPLATES must not be empty')
    .default('/opt/nuclei-templates/dast'),
  SAKUDA_NUCLEI_MAX_MINUTES: z.coerce.number().int().positive().default(60),
  SAKUDA_NUCLEI_CONCURRENCY: z.coerce.number().int().positive().default(25),
  SAKUDA_OAST: oastServer,
  SAKUDA_OAST_TOKEN: optionalString,
  SAKUDA_KATANA_BIN: z.string().default('katana'),
  SAKUDA_DALFOX_BIN: z.string().default('dalfox'),
  SAKUDA_DALFOX_MAX_MINUTES: z.coerce.number().int().positive().default(10),
  // Bounded parallelism for the XSS pass — deliberately small: dalfox is
  // aimed at a curated saved-target list, not a large recon dump.
  SAKUDA_DALFOX_CONCURRENCY: z.coerce.number().int().positive().default(10),
  SAKUDA_DALFOX_MAX_TARGETS: z.coerce.number().int().positive().default(50),
  SAKUDA_HTTPX_BIN: z.string().default('httpx'),
  SAKUDA_HTTPX_MAX_MINUTES: z.coerce.number().int().positive().default(5),
  SAKUDA_HTTPX_PRUNE_STATUS_CODES: pruneStatusCodes,
  SAKUDA_ZAP_CMD: z.string().default('zap.sh'),
  SAKUDA_ZAP_WORKDIR: optionalString,
  SAKUDA_ZAP_MAX_HEAP: z
    .string()
    .regex(/^\d+[kKmMgG]?$/)
    .default('1024m'),
  SAKUDA_LOCALHOST_ALIAS: optionalString,
  SAKUDA_ZAP_LOCALHOST_ALIAS: optionalString,
  SAKUDA_ENGINE_GRACE_MINUTES: z.coerce.number().int().nonnegative().default(10),
  SAKUDA_JOB_RUNNER: z.enum(['on', 'off']).default('on'),
  // Chrome DevTools endpoint of the host browser used for auth capture (#17).
  // Only ever read from env, never from a request (no SSRF). Docker sets it to
  // host.docker.internal via docker-compose.yml; dev on the host uses loopback.
  SAKUDA_CAPTURE_CDP_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:9222'),
  ),
  SAKUDA_ALLOWED_HOSTS: allowedHosts,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

const EnvSchema = EnvObject.superRefine((v, ctx) => {
  // A token only means something to a self-hosted server; with public/off it
  // would be silently unused, so say so at startup. The value is never echoed.
  if (v.SAKUDA_OAST_TOKEN !== undefined && (v.SAKUDA_OAST === 'public' || v.SAKUDA_OAST === 'off'))
    ctx.addIssue({
      code: 'custom',
      path: ['SAKUDA_OAST_TOKEN'],
      message: `is set but SAKUDA_OAST=${v.SAKUDA_OAST}; a token applies only to a self-hosted interactsh server URL`,
    })
})

function toOastConfig(server: string, token: string | undefined): OastConfig {
  if (server === 'public') return { mode: 'public' }
  if (server === 'off') return { mode: 'off' }
  return { mode: 'self-hosted', serverUrl: server.replace(/\/+$/, ''), token }
}

export interface Env {
  encryptionKey: string
  dataDir: string
  dbFile: string
  scansDir: string
  /** Per-discovery work dirs (ZAP plan/logs/site-tree dump), sibling of `scansDir`. */
  discoveriesDir: string
  migrationsDir: string
  localhostAlias: string | undefined
  nuclei: {
    bin: string
    templatesDir: string
    dastTemplatesDir: string
    maxMinutes: number
    concurrency: number
    /** interactsh (OAST) for out-of-band templates such as blind SSRF (#35). */
    oast: OastConfig
  }
  /** katana's time budget is the site's `zapFeSpiderMaxMinutes` — no env knob. */
  katana: { bin: string }
  dalfox: {
    bin: string
    maxMinutes: number
    concurrency: number
    maxTargets: number
  }
  /** nuclei's pre-scan liveness probe (#91): one GET per target before the
   * targets file is written. Annotates by default; drops a target only for a
   * status listed in `pruneStatusCodes` (opt-in, empty by default). */
  httpx: {
    bin: string
    maxMinutes: number
    pruneStatusCodes: number[]
  }
  zap: {
    cmd: string
    workDir: string | undefined
    maxHeap: string
    localhostAlias: string | undefined
  }
  engineGraceMinutes: number
  jobRunner: boolean
  /** DevTools HTTP endpoint of the host Chrome used for auth capture (#17). */
  captureCdpUrl: string
  /** Hostnames `/api/**` accepts in `Host`/`Origin` besides loopback (#22).
   * Never applied to `/mcp`. */
  allowedHosts: string[]
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const r = EnvSchema.safeParse(raw)
  if (!r.success)
    throw new EnvError(
      'invalid environment: ' +
        r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
  const v = r.data
  const dataDir = resolve(v.SAKUDA_DATA_DIR)
  return {
    encryptionKey: v.SAKUDA_ENCRYPTION_KEY,
    dataDir,
    dbFile: resolve(dataDir, 'sakuda.db'),
    scansDir: resolve(dataDir, 'scans'),
    discoveriesDir: resolve(dataDir, 'discoveries'),
    migrationsDir: resolve(v.SAKUDA_MIGRATIONS_DIR),
    localhostAlias: v.SAKUDA_LOCALHOST_ALIAS,
    nuclei: {
      bin: resolveExecutablePath(v.SAKUDA_NUCLEI_BIN),
      templatesDir: v.SAKUDA_NUCLEI_TEMPLATES,
      dastTemplatesDir: v.SAKUDA_NUCLEI_DAST_TEMPLATES,
      maxMinutes: v.SAKUDA_NUCLEI_MAX_MINUTES,
      concurrency: v.SAKUDA_NUCLEI_CONCURRENCY,
      oast: toOastConfig(v.SAKUDA_OAST, v.SAKUDA_OAST_TOKEN),
    },
    katana: { bin: resolveExecutablePath(v.SAKUDA_KATANA_BIN) },
    dalfox: {
      bin: resolveExecutablePath(v.SAKUDA_DALFOX_BIN),
      maxMinutes: v.SAKUDA_DALFOX_MAX_MINUTES,
      concurrency: v.SAKUDA_DALFOX_CONCURRENCY,
      maxTargets: v.SAKUDA_DALFOX_MAX_TARGETS,
    },
    httpx: {
      bin: resolveExecutablePath(v.SAKUDA_HTTPX_BIN),
      maxMinutes: v.SAKUDA_HTTPX_MAX_MINUTES,
      pruneStatusCodes: v.SAKUDA_HTTPX_PRUNE_STATUS_CODES,
    },
    zap: {
      cmd: resolveExecutablePath(v.SAKUDA_ZAP_CMD),
      workDir: v.SAKUDA_ZAP_WORKDIR,
      maxHeap: v.SAKUDA_ZAP_MAX_HEAP,
      localhostAlias: v.SAKUDA_ZAP_LOCALHOST_ALIAS ?? v.SAKUDA_LOCALHOST_ALIAS,
    },
    engineGraceMinutes: v.SAKUDA_ENGINE_GRACE_MINUTES,
    jobRunner: v.SAKUDA_JOB_RUNNER === 'on',
    captureCdpUrl: v.SAKUDA_CAPTURE_CDP_URL.replace(/\/+$/, ''),
    allowedHosts: v.SAKUDA_ALLOWED_HOSTS,
    logLevel: v.LOG_LEVEL,
  }
}

/** Env vars that sakuda no longer reads but that an older `.env` may still
 * set. Returned (names only, never values) so boot can say they are ignored
 * instead of silently changing behavior. */
export function retiredEnvWarnings(raw: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = []
  if (raw.SAKUDA_MCP_API_KEY?.trim())
    warnings.push(
      'SAKUDA_MCP_API_KEY is no longer used and is ignored (#20). ' +
        'Issue MCP API keys on the MCP page of the sakuda UI instead, then remove it from .env.',
    )
  return warnings
}

/** Boot warning when `/api/**` accepts more than loopback: the listed hosts
 * get the whole API, including stored secrets, with no login (#22). */
export function allowedHostsWarnings(env: Pick<Env, 'allowedHosts'>): string[] {
  if (env.allowedHosts.length === 0) return []
  return [
    `SAKUDA_ALLOWED_HOSTS is set: /api/** also accepts Host/Origin ${env.allowedHosts.join(', ')}. ` +
      'sakuda has no login, so anyone who can reach it under these names can read stored secrets ' +
      'and start scans. /mcp stays loopback-only.',
  ]
}

let cached: Env | undefined

export function getEnv(): Env {
  cached ??= parseEnv(process.env)
  return cached
}

export function resetEnvCache(): void {
  cached = undefined
}
