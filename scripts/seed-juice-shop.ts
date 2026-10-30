/**
 * `task juice-seed` / `pnpm seed:juice` — register the OWASP Juice Shop demo
 * site in a running sakuda (#102): demo user → login → JWT → one "Juice Shop"
 * site with Authorization / Cookie headers and the localStorage token, from
 * `targets/juice-shop/site.json`. Safe to re-run: the site is matched by name
 * and only its secrets are refreshed.
 *
 * Needs `task up` (sakuda on SAKUDA_PORT) and `task juice-up` (Juice Shop on
 * JUICESHOP_PORT). Ports come from the environment, falling back to `.env`,
 * then to the defaults below.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { applyJuiceOrigin, seedJuiceShop, type SiteTemplate } from './lib/seedJuiceShop.ts'

const REQUEST_TIMEOUT_MS = 10_000

/** Fixed demo account. Recreating the Juice Shop container drops it; the
 * next run registers it again. Not a secret: it exists only on a local
 * throwaway instance. */
const DEMO_CREDENTIALS = {
  email: 'demo@sakuda.local',
  password: 'sakuda-demo-account',
  securityAnswer: 'sakuda',
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadDotEnv(): void {
  const envFile = join(repoRoot, '.env')
  // process.loadEnvFile never overrides variables already set — so `task`
  // (which exports .env itself) and explicit `SAKUDA_PORT=… pnpm seed:juice`
  // both win over the file.
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}

function localOrigin(host: string, portVar: string, fallback: string): string {
  const raw = process.env[portVar] ?? fallback
  if (!/^\d{1,5}$/.test(raw)) throw new Error(`${portVar} must be a port number, got "${raw}"`)
  return `http://${host}:${raw}`
}

const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

async function main(): Promise<void> {
  loadDotEnv()
  // sakuda: `localhost`, so the Docker image (published on 127.0.0.1) and
  // `task dev` (Nuxt listens on ::1) are both reached. Juice Shop: 127.0.0.1,
  // because this origin is what gets stored as the site's frontBaseUrl and
  // must match what `task juice-up` publishes and site.json is written against.
  const sakudaOrigin = localOrigin('localhost', 'SAKUDA_PORT', '3001')
  const juiceOrigin = localOrigin('127.0.0.1', 'JUICESHOP_PORT', '4001')
  const templatePath = join(repoRoot, 'targets', 'juice-shop', 'site.json')
  const template = JSON.parse(readFileSync(templatePath, 'utf8')) as SiteTemplate
  const site = applyJuiceOrigin(template, juiceOrigin)

  const result = await seedJuiceShop({
    juiceOrigin,
    sakudaOrigin,
    credentials: DEMO_CREDENTIALS,
    site,
    fetch: fetchWithTimeout,
  })
  console.log(
    `juice-seed: ${result.action} site "${site.name}" (${result.siteId}) → ${sakudaOrigin}/sites/${result.siteId}`,
  )
  console.log(
    `juice-seed: headers Authorization + Cookie and localStorage token hold this run's JWT; re-run after "task juice-down && task juice-up"`,
  )
}

/** `fetch` reports a refused connection as a bare "fetch failed" and keeps
 * the reason (ECONNREFUSED, which host:port) in `cause` — surface it. */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const cause = e.cause instanceof Error ? ` (${e.cause.message})` : ''
  return `${e.message}${cause}`
}

main().catch((e: unknown) => {
  console.error(`juice-seed: ${describeError(e)}`)
  console.error(
    'juice-seed: check that sakuda (task up) and Juice Shop (task juice-up) are running on SAKUDA_PORT / JUICESHOP_PORT',
  )
  process.exitCode = 1
})
