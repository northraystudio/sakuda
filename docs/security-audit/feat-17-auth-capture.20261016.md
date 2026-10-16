# Security Audit: feat/17 auth capture and secret reveal — 2026-10-16

> Scope: `server/capture/`, `server/lib/`, `server/api/sites/[id]/{secrets.get.ts,capture/,scans.post.ts}`, `server/services/{captureService,siteService}.ts`, `server/domain/{secretExpiry,captureCandidates}.ts`, `shared/utils/secretExpiry.ts`, `app/components/site/`, `app/pages/sites/[id]/`, `Makefile`, `docker-compose.yml` | Stack: TypeScript / Nuxt 4 (h3 v1) / Chrome DevTools Protocol | Auditor: Claude vulnerability-scan skill
> Read-only inspection. One finding was remediated in this branch under the resolver loop.

---

## Executive Summary

This branch adds the first HTTP routes that return decrypted secrets (`GET /api/sites/:id/secrets`) and that drive a browser on the operator's machine (`POST /api/sites/:id/capture{,/start}`). All of them reuse the MCP loopback `Host`/`Origin` guard, the routes that return secrets send `no-store`, and the CDP endpoint is read from env only. Semgrep (`--config auto`) reported nothing. Manual review found one Medium issue: the remote-debugging Chrome stayed open with a persistent profile. It was fixed in this branch (iteration 1). One Low residual risk is accepted, and one finding that predates this branch is listed for a separate Issue.

**Critical/High findings requiring immediate action:** 0
**Total findings:** 2 true positives (1 fixed, 1 accepted Low) | 0 false positives | 1 pre-existing (out of scope)

---

## Finding Summary

| ID   | Title                                                                   | Severity | Location                                                            | Status                       |
| ---- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- | ---------------------------- |
| V-01 | Capture Chrome left running with DevTools open and a persistent profile | Medium   | `Makefile` (`capture-browser`), `server/services/captureService.ts` | True Positive, fixed         |
| V-02 | Secrets endpoint readable by any local process                          | Low      | `server/api/sites/[id]/secrets.get.ts`                              | True Positive, accepted      |
| P-01 | Rest of the HTTP API has no Host/Origin guard (DNS rebinding)           | Medium   | `server/api/**` (all other routes)                                  | Pre-existing, not fixed here |

---

## Findings

### V-01 — Capture Chrome left running with DevTools open and a persistent profile

**Severity**: Medium | **Location**: `Makefile` (`capture-browser`), `server/services/captureService.ts` (`finishCapture`) | **Confidence**: High

#### Attack Path

1. `make capture-browser` started Chrome with `--remote-debugging-port=9222` and a fixed profile at `~/.sakuda/capture-profile`, and nothing ever shut it down.
2. While it runs, any process on the host can drive the browser with no authentication. With Docker Desktop, so can any container, through `host.docker.internal`.
3. The profile keeps the target's session cookies on disk between launches.
4. **Impact**: Another local program or container can read or act with the logged-in session. The precondition is local code execution, so the severity is Medium.

#### Fix (applied, 39b016d)

- After a successful capture, `finishCapture` calls `closeBrowser` (CDP `Browser.close`), so the port does not stay open. A failure is logged with a hint to quit Chrome by hand.
- `make capture-browser` now creates a fresh `mktemp -d` profile for every launch.
- The README (both languages) states the exposure window: while that Chrome runs, anything on the host can drive it.
- Covered by tests: `cdp.spec.ts` ("sends Browser.close…") and `captureService.spec.ts` ("shuts the capture browser…").

Residual: the port is open between "Log in with browser" and "Capture". This is inherent to driving a real browser over CDP. `--remote-debugging-pipe` would close the gap, but sakuda runs in a container and cannot use a pipe to a host browser.

### V-02 — Secrets endpoint readable by any local process

**Severity**: Low | **Location**: `server/api/sites/[id]/secrets.get.ts` | **Confidence**: High

#### Attack Path

1. Any process on the host can `GET /api/sites/<uuid>/secrets` and receive decrypted header and storage values.
2. Browsers are blocked:
   - A DNS-rebinding page is rejected, because its `Host` is not a loopback name (403).
   - A cross-origin `fetch` is rejected, because its `Origin` is not a loopback origin (403).
   - A no-cors `<script>`/`<img>` load gets an opaque or unparseable response. The body is a JSON object, and sakuda sends no CORS headers.
3. **Impact**: This matches the documented trust model ("sakuda has no authentication; keep it on loopback"). The same values were already reachable by a local process through the data volume plus `SAKUDA_ENCRYPTION_KEY` in `.env`. Accepted.

---

## Pre-existing (not fixed in this branch)

### P-01 — Rest of the HTTP API has no Host/Origin guard

Only `/mcp` and the new secrets and capture routes check `Host`/`Origin`. Every other route, including create site, start scan, and delete, has no such check. A DNS-rebinding page is same-origin with sakuda after it rebinds, so it can send JSON `POST`/`PUT`/`DELETE` requests and start scans against an attacker-chosen site. This does not regress on this branch: `main` has the same behavior. Recommended: a Nitro middleware that applies `requireLoopbackRequest` to every `/api/**` route, with a deliberate opt-out for a reverse-proxy deployment. Register it via `report-to-issues`.

---

## Manual review notes (no finding)

- **SSRF**: The CDP base URL comes from `SAKUDA_CAPTURE_CDP_URL` only, restricted to `http(s)`. The tab URL is the site's own `frontBaseUrl`, configured by the operator. `targetId` is validated as 32 hex characters before it reaches a URL path, both in the route schema and in `isTargetId`.
- **Logging**: The capture logs carry only `siteId`, `targetId` and counts. The first count key was `headers` and was hidden by the `headers` redact path, so it was renamed to `headerCount`. CDP error messages include origins and at most 200 characters of a DevTools response, never captured values.
- **XSS**: Captured values are bound only through `v-model` and `{{ }}`. Nothing uses `v-html` or `innerHTML`.
- **Parsing**: The JWT `exp` decode is wrapped in `try`. The regex is linear, and values are capped at 10,000 characters by the schema.
- **Mass assignment**: A client-supplied `expiresAt` only changes a warning, and the schema requires a value with it.
- **Wrong-origin capture**: Storage is read only when the tab's `location.origin` equals the site's front origin. Otherwise the request fails with `WRONG_ORIGIN` (409).

---

## Dependency Audit

No dependency changed on this branch (`package.json` and `pnpm-lock.yaml` are untouched). `pnpm audit` shows 1 moderate, plus 4 high and 2 critical that are already on the ignore list tracked in #13. No new advisories.

---

## Remediation Priority

| Priority                     | Finding             | Action                                                      |
| ---------------------------- | ------------------- | ----------------------------------------------------------- |
| Done                         | V-01                | Browser closed after capture, throwaway profile, documented |
| Accepted                     | V-02                | Matches the documented loopback trust model                 |
| Separate Issue (recommended) | P-01 (pre-existing) | API-wide Host/Origin middleware                             |
