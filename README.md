# sakuda

English | [日本語](README.ja.md)

## Contents

- [Coverage and limits](#coverage-and-limits)
- [Quick start (Docker)](#quick-start-docker)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Scan data on disk](#scan-data-on-disk)
- [Scanning — engines and active checks](#scanning--engines-and-active-checks)
- [Discovery — filling the target list](#discovery--filling-the-target-list)
- [MCP (agent access)](#mcp-agent-access)
  - [API keys](#api-keys) · [Claude Code](#claude-code) ·
    [Claude Desktop](#claude-desktop) · [Tools and secrets](#tools-and-secrets)
- [Not in this MVP](#not-in-this-mvp)
- [License](#license)

**sakuda** is short for **「さくっとDAST」** ("DAST, quickly") — the aim is a
useful security scan with as little setup as possible.

A **self-hosted DAST** (dynamic application security testing) web application
security scanner that ships as **one Docker image**: **OWASP ZAP**, **nuclei**,
**katana**, **httpx** and **dalfox** behind a **Nuxt** UI. It covers what the
individual tools leave to you — **authenticated scanning** of single-page apps
(header injection plus browser storage seeding), **OpenAPI-driven active
scans** (documented endpoints and a spec generated from the crawl), **XSS /
SQL injection / command injection** checks gated behind an explicit opt-in,
and honest **per-engine reports** with a diff against the previous scan,
history charts and Markdown export. Point it at a **target you own** — an
OWASP Juice Shop demo is one command away — and it runs a bounded,
time-budgeted scan and tells you exactly what it did and did not cover.

Register a **site**, run scans against it with **nuclei**, **ZAP API** (active
scan against an OpenAPI spec), **ZAP frontend** (spider + baseline against a
seed page) and/or **Dalfox** (bounded reflected/DOM XSS), and browse the
results from the UI. **Discovery** is separate from scanning: ZAP's spider and
katana crawl the site, you review the URLs they found and save the ones you
want as target paths, and nuclei scans that saved list on every run — no need
to crawl again until the site changes.

MVP scope: sites → scans → per-engine reports. See
[Not in this MVP](#not-in-this-mvp) for what's deliberately out.

**Live scan progress** — while a scan runs, each engine on the left takes its
turn attacking the target on the right: its defenses break as the engines
progress, every new finding flashes on the target, and a terminal readout
shows the current stage:

![sakuda scan in progress: engines stacked on the left (ZAP Frontend and Dalfox done with their finding counts, Nuclei queued) sending packets at the target site's server on the right, whose defense rings are partly broken, above a terminal log of the latest stages](docs/images/scanning.png)

**Scan report** — severity summary, the diff against the previous scan, and a
per-engine panel with its status, run time and time limit:

![sakuda scan report: a severity summary (critical / high / medium / low / info), a "changes vs previous scan" diff, and the ZAP API engine panel showing status, run time and time limit](docs/images/scan-report.jpg)

**Site page** — findings history over time (by severity, by engine, and
new / persisting / resolved), the saved target list, and the discovery panel:

![sakuda site page: three history charts (findings by severity, by engine, and new/persisting/resolved) above the saved target list and the discovery panel](docs/images/site-history.jpg)

## Coverage and limits

True to the name, sakuda tries to diagnose as much as it can with little
effort — but **automated DAST cannot find every vulnerability, and a clean
scan is not proof that a target is secure.** It is strong on the classes its
engines actively test (injection, misconfiguration, exposure, redirects) and
blind to what needs human reasoning:

- **Business logic and authorization-workflow flaws** — price tampering,
  broken object-level access, multi-step abuse. Payload scanners don't reason
  about intent.
- **Anything OSINT- or context-dependent** — guessable credentials, leaked
  secrets, information only meaningful to someone who knows the app.
- **Classes that need a custom nuclei template or a hand-written OpenAPI
  spec** to be reached at all, and endpoints the crawl never discovers.
- **Partial runs** — an engine that hits its time limit is reported as
  _stopped at limit_; the absence of a finding there is not the absence of the
  bug.

Read a clean result as "nothing these engines found within this budget", and
pair sakuda with manual testing — use it to surface issues fast, not as a
completeness guarantee.

## Quick start (Docker)

Everything — the app, nuclei + templates, and ZAP — ships in one image.
`docker-compose.yml` + `Makefile` wrap the commands; every port and secret is
read from `.env`.

```bash
make env      # .env from .env.example with a fresh SAKUDA_ENCRYPTION_KEY
make build    # build the image (10–20 min the first time)
make up       # start → http://localhost:3001
make logs     # follow logs · make restart · make ps
make down && make up   # recreate sakuda (e.g. after make build)
make down     # stops sakuda only — the data volume and Juice Shop are untouched
make juice-up && make juice-seed   # optional: OWASP Juice Shop as a ready-to-scan demo site (auth included)
```

`make help` lists every target. Without make:

```bash
docker compose up -d sakuda          # same thing, reads .env
# or plain docker:
docker build -t sakuda .
docker run -d --name sakuda -p 127.0.0.1:3001:3000 --shm-size=1g \
  --add-host=host.docker.internal:host-gateway \
  -e SAKUDA_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -v sakuda-data:/data \
  sakuda
```

### Ports

The container always listens on **3000**; the host-side ports come from
`.env` so sakuda can coexist with other local stacks:

| `.env` variable  | Default     | What                                                                   |
| ---------------- | ----------- | ---------------------------------------------------------------------- |
| `SAKUDA_PORT`    | `3001`      | sakuda UI/API (`make up`, `make dev`)                                  |
| `JUICESHOP_PORT` | `4001`      | OWASP Juice Shop dry-run target (`make juice-up`, own compose project) |
| `SAKUDA_BIND`    | `127.0.0.1` | Bind address for published ports — keep it loopback-only               |

Override per invocation with `make up SAKUDA_PORT=3005`.

- **Trust model: sakuda has no authentication.** Anyone who can reach the
  port can read/create/modify sites (including their configured headers) and
  start scans against arbitrary hosts. Bind it to loopback only (the default
  `SAKUDA_BIND=127.0.0.1`) or put it behind an authenticating reverse proxy —
  never publish it on `0.0.0.0` on a shared or internet-facing host.
- **Loopback names only.** The HTTP API (`/api/**`) answers 403 unless `Host`
  and `Origin` (when sent) are `localhost`, `127.0.0.1` or `[::1]`, so a page
  that re-points its own domain at your machine (DNS rebinding) cannot drive
  it. Behind a reverse proxy or over the LAN, list the names you open sakuda
  by in `SAKUDA_ALLOWED_HOSTS` (e.g. `sakuda.lan,192.168.1.5`); startup logs a
  warning while it is set. The check cannot be turned off, and `/mcp` stays
  loopback-only either way. The list applies to the built app (`make up`);
  under `pnpm dev`, Vite's own host check still refuses names other than
  loopback.
- **Keep the key.** `SAKUDA_ENCRYPTION_KEY` encrypts stored request headers
  (Cookie/Bearer/etc.) at rest. If you lose it, those headers become
  permanently unreadable — write it down somewhere safe (e.g. a password
  manager), it is not recoverable from the data volume.
- **Memory:** give Docker Desktop **6–8 GB** of RAM — the ZAP frontend engine
  (`zap-fe`) is the heaviest consumer and will fail or be OOM-killed on less.
- **Target URLs on your host machine**: when a site's base URL is
  `http://localhost:PORT` (or `127.0.0.1`), sakuda automatically rewrites it
  to `host.docker.internal` for engines running inside the container — no
  extra configuration needed, as long as the container was started with
  `--add-host=host.docker.internal:host-gateway` (as above). The Firefox that
  ZAP's Ajax spider drives is also told to treat that alias as a **secure
  context** (`dom.securecontext.allowlist`): a plain-http, non-localhost
  origin has no `crypto.randomUUID` / `crypto.subtle` / service workers, and
  an SPA that touches one of them while bootstrapping auth would otherwise
  fail silently and crawl as an anonymous visitor.

## Environment variables

| Variable                          | Default                                                                | Notes                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `SAKUDA_ENCRYPTION_KEY`           | _(required)_                                                           | base64 of 32 random bytes. Generate with `pnpm keygen` or `openssl rand -base64 32`.                                             |
| `SAKUDA_DATA_DIR`                 | `./data` (`/data` in the image)                                        | SQLite DB + per-scan work dirs live here.                                                                                        |
| `SAKUDA_MIGRATIONS_DIR`           | `./server/db/migrations` (`/app/migrations` in the image)              | Drizzle migrations applied on boot.                                                                                              |
| `SAKUDA_NUCLEI_BIN`               | `nuclei` (`/usr/local/bin/nuclei` in the image)                        | Path to the nuclei binary.                                                                                                       |
| `SAKUDA_NUCLEI_TEMPLATES`         | `/opt/nuclei-templates/http`                                           | Pinned nuclei-templates checkout.                                                                                                |
| `SAKUDA_NUCLEI_DAST_TEMPLATES`    | `/opt/nuclei-templates/dast`                                           | DAST (fuzzing) templates, loaded only for sites with "Active injection checks" on.                                               |
| `SAKUDA_NUCLEI_MAX_MINUTES`       | `60`                                                                   | Hard timeout for a nuclei run, shared across its phases (DAST / signature / OpenAPI).                                            |
| `SAKUDA_NUCLEI_CONCURRENCY`       | `25`                                                                   | nuclei parallelism (`-c`). Lower it for a slow or fragile target so a run wastes less time waiting on slow responses.            |
| `SAKUDA_KATANA_BIN`               | `katana` (`/usr/local/bin/katana` in the image)                        | Path to the katana binary (discovery's second URL source). Its time budget is the site's spider minutes; no separate knob.       |
| `SAKUDA_DALFOX_BIN`               | `dalfox` (`/usr/local/bin/dalfox` in the image)                        | Path to the dalfox binary (the reflected/DOM XSS engine). Runs only under active injection checks.                               |
| `SAKUDA_DALFOX_MAX_MINUTES`       | `10`                                                                   | Wall-clock budget for one dalfox run.                                                                                            |
| `SAKUDA_DALFOX_CONCURRENCY`       | `10`                                                                   | dalfox parallelism (workers / concurrent targets). Kept small — it scans a curated target list, not a recon dump.                |
| `SAKUDA_DALFOX_MAX_TARGETS`       | `50`                                                                   | Cap on how many saved GET targets one dalfox run consumes.                                                                       |
| `SAKUDA_HTTPX_BIN`                | `httpx` (`/usr/local/bin/httpx` in the image)                          | Path to the httpx binary — nuclei's pre-scan liveness probe. Missing → every target passes through, with a warning.              |
| `SAKUDA_HTTPX_MAX_MINUTES`        | `5`                                                                    | Cap for the whole probe, counted inside the nuclei run's time budget.                                                            |
| `SAKUDA_HTTPX_PRUNE_STATUS_CODES` | _(empty = off)_                                                        | Opt-in: 4xx codes (never 405/429) whose targets are dropped from the nuclei list, e.g. `404,410`. Off by default — see below.    |
| `SAKUDA_ZAP_CMD`                  | `zap.sh` (`/zap/zap.sh` in the image)                                  | ZAP entrypoint. Dev on macOS: `./scripts/zap-docker.sh`.                                                                         |
| `SAKUDA_ZAP_WORKDIR`              | _(unset)_                                                              | Container-side path when ZAP sees the scan work dir at a different path than the host (the dev wrapper mounts it at `/zap/wrk`). |
| `SAKUDA_ZAP_MAX_HEAP`             | `1024m`                                                                | `-Xmx` passed to ZAP via `JAVA_TOOL_OPTIONS`.                                                                                    |
| `SAKUDA_LOCALHOST_ALIAS`          | _(unset)_                                                              | Rewrites `localhost`/`127.0.0.1` in target URLs for all engines.                                                                 |
| `SAKUDA_ZAP_LOCALHOST_ALIAS`      | `host.docker.internal`                                                 | Same, for ZAP only (falls back to `SAKUDA_LOCALHOST_ALIAS`). ZAP's Firefox treats this host as a secure context.                 |
| `SAKUDA_ENGINE_GRACE_MINUTES`     | `10`                                                                   | Grace period before an orphaned engine process is treated as failed.                                                             |
| `SAKUDA_JOB_RUNNER`               | `on`                                                                   | Set `off` to disable the in-process scan queue (e.g. in tests).                                                                  |
| `SAKUDA_CAPTURE_CDP_URL`          | `http://127.0.0.1:9222` (`http://host.docker.internal:9222` in Docker) | DevTools endpoint of the host Chrome used by **Log in with browser** (`make capture-browser`). Read from env only.               |
| `SAKUDA_ALLOWED_HOSTS`            | _(unset)_                                                              | Comma-separated hostnames (no port) that `/api/**` accepts in `Host`/`Origin` besides loopback. See the trust model above.       |
| `LOG_LEVEL`                       | `info`                                                                 | `debug` \| `info` \| `warn` \| `error`.                                                                                          |

Full defaults and validation: `server/config/env.ts`. See `.env.example` for
a copyable local `.env`.

## Local development

```bash
pnpm install
make env                    # .env with a fresh key (or: cp .env.example .env && pnpm keygen)
```

nuclei, katana, dalfox and httpx run as native binaries and ZAP runs via Docker in dev:

- Install nuclei locally (e.g. `go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest`)
  and clone [nuclei-templates](https://github.com/projectdiscovery/nuclei-templates),
  then point `.env` at them: `SAKUDA_NUCLEI_BIN`, `SAKUDA_NUCLEI_TEMPLATES`.
- Install katana locally (`go install github.com/projectdiscovery/katana/cmd/katana@v1.7.0`,
  the version pinned in the Dockerfile) and point `SAKUDA_KATANA_BIN` at it. Without
  it, discovery still works on ZAP alone and reports the missing binary as a warning.
- Install dalfox locally (`brew install dalfox`, or download the pinned
  v3.2.2 release) and point `SAKUDA_DALFOX_BIN` at it. Without it, a scan that
  selects the XSS engine fails that engine run with a clear "binary not found"
  error; the other engines are unaffected.
- Install httpx locally (`go install github.com/projectdiscovery/httpx/cmd/httpx@v1.12.0`,
  the version pinned in the Dockerfile; `brew install httpx` also works) and point
  `SAKUDA_HTTPX_BIN` at it. Without it, nuclei scans the full saved list as before and
  the scan carries a "probe did not run" warning.
- ZAP runs inside Docker via `scripts/zap-docker.sh` (no local ZAP install
  needed). Set in `.env`:
  ```
  SAKUDA_ZAP_CMD=./scripts/zap-docker.sh
  SAKUDA_ZAP_WORKDIR=/zap/wrk
  SAKUDA_ZAP_LOCALHOST_ALIAS=host.docker.internal
  ```
  Note: sending SIGKILL to the `docker run` client does not stop the ZAP
  container — SIGTERM is proxied through to it, and sakuda's engine runner
  sends SIGTERM first, so a graceful stop/timeout works as expected.

Then:

```bash
make dev            # nuxt dev on SAKUDA_PORT → http://localhost:3001
make test           # unit + component tests
make e2e            # API e2e tests
make lint · make typecheck · make check (all three)
make juice-up       # Juice Shop on JUICESHOP_PORT as a scan target · make juice-down
make juice-seed     # register it in sakuda as a logged-in demo site (idempotent; re-run after juice-down/up)
```

Juice Shop is a separate compose project (`targets/juice-shop/compose.yml`,
project `sakuda-juice-shop`) that reads the same `.env`, so `make down` /
`make reset-data` never touch it. Without make:
`docker compose --env-file .env -f targets/juice-shop/compose.yml up -d`.
Recreating the container (`make juice-down`) resets its accounts and tokens.
Upgrading from a checkout where Juice Shop lived in `docker-compose.yml`:
remove the old container once with `docker rm -f sakuda-juice-shop`, then
`make juice-up`.

(`pnpm dev --port 3001`, `pnpm test`, `pnpm test:e2e`, `pnpm run lint`,
`pnpm run typecheck` underneath.)

## Scan data on disk

`data/scans/<scanId>/<engine>/` keeps each engine's raw logs and reports
(stdout/stderr, ZAP's plan/report JSON, nuclei's JSONL output, the httpx
probe's JSONL and argv under `nuclei/httpx/`). The site's request headers
reach nuclei, katana and httpx through a `headers.json` written next to the
engine's files for the duration of the run only (0600, removed afterwards),
never on the command line. This can
contain target application data (response fragments, discovered paths) —
treat the `data/` directory as sensitive, do not commit it or share it
outside the team that owns the scanned target.

**Retention model:** there is no per-scan expiry — a site's scan artifacts
live on disk for as long as the site exists, and are deleted (best-effort)
when the site itself is deleted.

## Scanning — engines and active checks

A scan runs one or more engines against a site; when all of them are
selected they run in this fixed order, each with its own time budget:

1. **ZAP API (active)** — drives ZAP's active scan from the site's OpenAPI
   spec (`openapiUrl` / `openapiJson`, plus a spec sakuda generates from saved
   non-GET targets when active checks are on). This is where documented
   endpoints get injection / redirect / SQLi coverage; the image pins ZAP's
   `ascanrulesBeta` add-on for NoSQL (MongoDB) and LDAP injection rules.
2. **ZAP Frontend (baseline)** — traditional + Ajax spiders from the seed
   page, a passive baseline scan, and a DOM-XSS probe over hash routes. The
   heaviest engine (it drives a real Firefox); size Docker's RAM as noted
   above.
3. **Dalfox (XSS)** — a bounded reflected + DOM(AST) cross-site-scripting
   pass over the saved GET targets. It runs **only when active injection
   checks are on**; otherwise its engine run is recorded as _skipped_ (not
   failed), and it is off by default in the engine picker. Mining, deep scan,
   stored/blind XSS, remote payload sources and external-JS fetching are all
   disabled — it consumes the curated target list, not a recon dump, and only
   a _verified_ finding is reported `high` (a reflection-only signal never is).
   It does not replace the ZAP frontend DOM-XSS probe over hash routes.
4. **Nuclei** — template scanning against the saved target paths (see
   [Discovery](#discovery--filling-the-target-list)).

**sakuda sends attack traffic — only scan targets you own or are authorized
to test.** The ZAP API engine active-scans the documented endpoints on every
run by design, independent of the toggle below.

**Active injection checks (per site).** This toggle broadens what the engines
are allowed to attack: mutating-method requests to saved targets, nuclei's
DAST fuzzing templates (GET and generated non-GET), ZAP's frontend active
scan, the Dalfox XSS engine, and form-submitting discovery (katana `-aff`,
ZAP `postForm`). With it off, those are held back. For a target that is not on your own machine, sakuda
additionally requires you to confirm you are authorized (`nonLocalConfirmed`)
before active checks take effect. Individual high-risk nuclei template groups
(known-CVE exploits, command-injection / RCE, denial-of-service) are each
opted in separately on the site form.

**How nuclei spends its time.** One nuclei run has up to three phases sharing
`SAKUDA_NUCLEI_MAX_MINUTES`:

1. **DAST** — fuzzing templates on the GET targets (active checks only). Runs
   first: it is short and catches the high-signal cases (SQLi, command
   injection).
2. **Signature** — the `http` template tree on the GET targets. The long
   phase.
3. **OpenAPI** — fuzzing the saved non-GET endpoints via a generated spec
   (active checks only).

Each phase reserves a floor of time for the phases still to come, so a slow
target can't let one phase consume the whole budget and leave the rest at 0%.
Lower `SAKUDA_NUCLEI_CONCURRENCY` for a slow target.

**Liveness probe (httpx).** Right before the target list is handed to
nuclei, sakuda probes it once with [httpx](https://github.com/projectdiscovery/httpx)
— one GET per target, no redirects followed, the saved scheme kept, with the
site's headers — and records what it saw under `nuclei/httpx/` and in the
engine's `meta.httpx` (inputs, observed, kept, dropped, status counts). **By
default nothing is dropped:** a 404 is not proof that nuclei would find
nothing there (error pages can carry XSS, auth can hide a resource, templates
request paths of their own), so the probe only annotates. Dropping targets by
status is an opt-in via `SAKUDA_HTTPX_PRUNE_STATUS_CODES` (e.g. `404,410`),
and even then a target is removed only on positive evidence — a target with
no line, a transport failure, or a 405 / 429 / 5xx is "unknown" and stays.
If httpx is missing, fails, or hits `SAKUDA_HTTPX_MAX_MINUTES`, the full list
goes to nuclei and the scan says so in a warning.

**Partial runs are reported honestly.** If an engine hits its time limit it is
marked _stopped at limit_ rather than shown as a clean finish, and it keeps
whatever it found up to that point. The scan page shows, per engine, its
status, elapsed / total time and the limit it ran under, alongside the
findings, a diff against the previous scan, and a Markdown export.

## Discovery — filling the target list

Nuclei does not crawl; it scans exactly the **target paths** saved on the
site (`/path` or `api:/path`, relative to the base URLs). On the site page:

1. **Discover URLs** runs ZAP's traditional + Ajax spiders from the seed path
   (each for up to `zapFeSpiderMaxMinutes`, with the site's headers) and dumps
   ZAP's site tree — every URL the crawl requested, not only the ones that
   raised an alert. In parallel, **katana** crawls the same seeds in static
   mode with JS-bundle parsing (`-jc`, depth 3, same time budget, same
   headers): it picks up the API paths that only exist as string literals in
   the app's bundles (`/api/Feedbacks`, `/rest/user/whoami`, …), which no
   spider ever clicks its way to. The two lists are merged (ZAP wins a tie)
   and each row shows its `source` — `spider`, `ajax` or `katana`. katana is
   scoped to the front host (`-fs fqdn`), so an `apiBaseUrl` on another origin
   is left to ZAP; and if katana fails or is missing, the ZAP result is kept
   and the failure is shown as a warning. Off-origin URLs, static assets,
   socket.io transports, stack-trace pseudo-paths, `excludePaths` matches and
   katana's regex artifacts (strings it scraped but never requested, `%5C%22`
   fragments) are dropped; the panel shows how many and why.
2. Tick the URLs you want scanned (everything not yet saved is pre-selected),
   add paths by hand if you like, and **Save to targets**. Saving appends to
   the list and never duplicates a path.
3. Start a scan. Nuclei uses the saved list; ZAP frontend still crawls from
   the seed path itself.

**Non-GET endpoints.** With active checks on, discovery also observes the
value-free _shape_ of the non-GET requests the app makes — a badge like
`form {email, password}` or `json {email, password}`, never the captured
values — and you approve those alongside the URLs. sakuda turns the approved
shapes into a generated OpenAPI spec so nuclei and ZAP API can fuzz those
endpoints, which is how an authenticated `POST /rest/user/login` becomes
reachable to injection checks without you hand-writing a spec.

**Single-page apps behind a login.** Header injection authenticates the
_requests_, but an SPA decides whether it is logged in from what it finds in
`localStorage` / `sessionStorage` / cookies — so with headers alone ZAP's
browser renders the anonymous UI and never reaches the basket, profile, …
pages or the APIs behind them. Register those values as **Browser storage**
on the site (kind + name + value; stored encrypted like headers; the site API
returns names only) and sakuda seeds them into ZAP's browser before every Ajax
spider run (discovery and ZAP frontend) via a Selenium `browserLaunched`
script that is written 0600 for the run and deleted afterwards. For OWASP
Juice Shop that is `localStorage token = <JWT>` plus `sessionStorage bid =
<basket id>` from `POST /rest/user/login`.

**Log in with a browser instead of copy-pasting.** Run `make capture-browser`
(a Chrome on your machine with a throwaway profile and DevTools on
`127.0.0.1:9222`), then in **Edit site → Authentication** press **Log in with
browser**: the site opens in that Chrome. Log in as usual, press
**Capture**, and the form is filled from the tab — every cookie (HttpOnly
included) and localStorage / sessionStorage entry as a Browser storage row,
plus a combined `Cookie` header and, when a stored value is a JWT, an
`Authorization: Bearer` header. Review the rows, remove what you do not
need, and save; nothing is stored until you do. Use the eye button on any
row to check a stored value for copy-paste mistakes. Known expiry times (a
JWT's `exp`, a captured cookie's `expires`) are kept in plaintext, shown next
to the row, and an expired or soon-expiring (≤ 60 min) login is flagged next
to **Start scan** and in the scan-create response. Like the rest of the API,
capture and the eye button only answer on a loopback `Host`/`Origin` (or one
in `SAKUDA_ALLOWED_HOSTS`). While that Chrome runs,
anything on this machine (including containers, via `host.docker.internal`)
can drive it, so sakuda quits it after **Capture** — quit it yourself if you
stop early. Requires Docker Desktop
(macOS / Windows) or sakuda running on the host; on Linux Docker,
`host.docker.internal` does not reach a Chrome bound to 127.0.0.1.

**Discovery seeds.** _Discovery seed paths_ (one per line, hash routes such
as `/#/search?q=apple` are fine) start one Ajax spider each; empty falls
back to the ZAP frontend seed path.

**"The app made no client-side API calls" warning.** A discovery whose Ajax
spider ran but produced no app-initiated API call (only assets and HTML
pages) usually means the SPA never booted or stayed anonymous — which
otherwise looks like a clean crawl with no warnings. Discovery flags it so
repeated empty runs are not mistaken for success. Check, in order: the
secure-context alias (`SAKUDA_ZAP_LOCALHOST_ALIAS`, needed so
`crypto.randomUUID` and friends work over a loopback origin), the site's
**Browser storage** login values, and — importantly — that the app's own
JavaScript is not being excluded. **Do not put `/_nuxt/*` (or your
framework's asset path) in `excludePaths` on a dev server:** ZAP will refuse
to fetch the bundle, the SPA cannot start, and every discovery comes back
empty. `excludePaths` is for endpoints that end the session or change data,
not for static assets (those are dropped from the target list automatically).

A site runs one job at a time: a discovery is refused while a scan is
queued/running and vice versa. Discovery artifacts (ZAP plan, logs, the
site-tree dump; katana's seeds, logs and JSONL under `katana/`) live under
`<data dir>/discoveries/<id>` and are removed with the site.

## MCP (agent access)

sakuda serves an [MCP](https://modelcontextprotocol.io) endpoint at `/mcp`
(Streamable HTTP), so an agent such as Claude Code or Claude Desktop can read
sites, scans, findings and diffs directly — and feed back what it learns from
the source: target paths, the OpenAPI document, scan starts and its verdict on
each finding.

### API keys

Open **MCP** in the header of the sakuda UI to issue a key with a label per
client (e.g. `claude-code`, `claude-desktop`). The key is shown **once**;
sakuda stores only a sha256 hash, so a lost key is reissued, not recovered.
Reissue and revoke take effect on the next request, without a restart: the old
key gets 401.

- **No key issued:** `/mcp` accepts loopback requests without auth, and secrets
  are always hidden. A request that does send a key is still checked, so a
  revoked key gets 401 even after the last key is gone.
- **One or more keys issued:** every MCP request must send a valid key (401
  otherwise), and `reveal` becomes available.
- `SAKUDA_MCP_API_KEY` is no longer read. If it is still set, sakuda logs a
  warning at boot and ignores it — issue a key in the UI and remove it from `.env`.

### Claude Code

Right after issuing a key, the MCP page shows two ready-to-paste lines:

```bash
claude mcp remove sakuda -s local
claude mcp add --transport http sakuda http://127.0.0.1:3001/mcp --header "Authorization: Bearer <key>"
```

The remove line replaces an existing `sakuda` entry, which `claude mcp add`
would refuse; on a first setup it just reports that nothing was found. With no
key issued, `claude mcp add --transport http sakuda http://127.0.0.1:3001/mcp`
is enough.

### Claude Desktop

Claude Desktop has no field for a static header on a remote server, so
bridge `/mcp` through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in
`~/Library/Application Support/Claude/claude_desktop_config.json` (issue a
separate key, e.g. labelled `claude-desktop`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "sakuda": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:3001/mcp",
        "--header",
        "Authorization:${SAKUDA_AUTH}"
      ],
      "env": { "SAKUDA_AUTH": "Bearer <key>" }
    }
  }
}
```

The value goes through `env` because a space inside an argument can be split on
some systems. If the log shows `Dynamic Client Registration rejected (HTTP 404)`
for `/register`, the key was rejected: sakuda answered 401 and `mcp-remote` fell
back to OAuth, which sakuda does not offer. Check that `SAKUDA_AUTH` starts with
`Bearer ` and holds a live key.

### Tools and secrets

Read tools: `list_sites`, `get_site`, `list_scans`, `get_scan`, `list_findings`.

Write tools go through the same validation and checks as the UI:

- `add_targets` — append target lines (`[METHOD] [api:]/path`); saved lines are skipped.
- `set_openapi` — set `openapiUrl` or `openapiJson` (the other is cleared). A
  non-local URL needs the site to be confirmed for non-local scanning in the UI
  first (the agent cannot confirm it) and must be on the site's front or API
  origin; a URL on any other host is set in the UI.
- `start_scan` — queue a scan; a refusal (unconfirmed non-local target, missing
  OpenAPI for `zap-api`, a scan or discovery already running) comes back with
  its code and reason. Active checks run only if the site enables them.
- `set_finding_triage` — record `confirmed`, `false-positive` or `accepted` with
  a reason. The verdict is kept per site and finding fingerprint (the same key
  the scan diff uses), so `false-positive` / `accepted` findings stop counting as
  new in later scans; the scan page shows the verdict and reason. Set
  `confirmed` to take a dismissal back. Verdicts are set over MCP only.

Re-sending the same targets, OpenAPI or verdict changes nothing.

- **Secrets are hidden by default.** Header, cookie and browser-storage values
  configured on the site are replaced with labeled placeholders such as
  `[SECRET:header:Authorization]`. `get_scan` / `list_findings` accept
  `reveal: true` to return the real values — only when the request sends a
  valid API key. Exact and URL-encoded forms are matched; values shorter than 6
  characters are left as is. Only the site's _current_ values are known, so a token you
  have since replaced is not recognized if an old scan's evidence echoes it.
- **Evidence is untrusted.** It is what the scanned server sent back, returned
  as `{untrusted: true, source: "target-response", text, truncated}` and cut
  to 2000 characters. Agents must treat it as data, not instructions.
- Only loopback `Host`/`Origin` values are accepted (DNS-rebinding guard).

## Not in this MVP

- Target ownership verification (file/DNS challenge)
- Login automation / authenticated crawling flows
- Scheduled/recurring scans
- Notifications (email/Slack/etc.)
- Multi-user accounts or access control

## License

[MIT](LICENSE). The scan engines sakuda drives are separate projects under
their own licenses: nuclei, katana, httpx, dalfox and nuclei-templates (MIT)
are downloaded, checksum-verified, at image build time, and ZAP (Apache-2.0)
is the image's base layer. None of them is vendored into this repository.
