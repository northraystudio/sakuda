# Security Audit: feat/16 MCP read endpoint — 2026-10-16

> Scope: `server/mcp/`, `server/routes/mcp.ts`, `server/config/env.ts` | Stack: TypeScript / Nuxt 4 (h3 v1) / MCP SDK v2 | Auditor: Claude vulnerability-scan skill
> Read-only inspection. One finding was remediated in this branch under the resolver loop.

---

## Executive Summary

The new `/mcp` endpoint is read-only, runs on loopback, and every tool calls existing services. Secrets are redacted by default, and returning them requires an API key. Semgrep (`--config auto`) reported nothing. Manual review found one Low gap: the redaction only matched exact values, so a URL-encoded reflection of a secret could pass through. It was fixed in this branch (iteration 1).

**Critical/High findings requiring immediate action:** 0
**Total findings:** 1 true positive (fixed) | 0 false positives

---

## Finding Summary

| ID   | Title                                          | Severity | Location               | Status               |
| ---- | ---------------------------------------------- | -------- | ---------------------- | -------------------- |
| V-01 | Secret redaction misses URL-encoded reflection | Low      | `server/mcp/redact.ts` | True Positive, fixed |

---

## Findings

### V-01 — Secret redaction misses URL-encoded reflection

**Severity**: Low | **Location**: `server/mcp/redact.ts` (`collectSecrets`) | **Confidence**: High

#### Attack Path

1. A site has a header secret containing `+`, `/`, `=` or a space (for example `Bearer abc+def/==`).
2. The scanned target echoes that header URL-encoded, for example in a redirect `Location` or a query parameter, and an engine records it in `evidence` or `url`.
3. `list_findings` without `reveal` returns `abc%2Bdef%2F%3D%3D` unredacted, because only the exact value was matched.
4. **Impact**: An agent may copy the credential into a public Issue (the maruda report-to-issues flow). The data stays on loopback and the caller is the operator's own agent, so the severity is Low.

#### Fix (applied)

`collectSecrets` now adds the `encodeURIComponent` form of every value, with the same label, and sorts all values longest first. A test covers this (`redact.spec.ts`: "also hides the URL-encoded form of a value").

---

## Manual Review Notes (no finding)

- **Authentication**: The optional `SAKUDA_MCP_API_KEY` is validated at startup (16 or more characters, fail fast) and compared as sha256 digests with `timingSafeEqual`. A request without the key, with a wrong key, or with a non-Bearer scheme gets 401 with `WWW-Authenticate: Bearer`. The key is never logged.
- **DNS rebinding / CSRF**: Host and Origin must be loopback names, and Origin `null` is rejected. The SDK returns 415 for a non-JSON content-type and 406 for a missing Accept header, so a `text/plain` form POST is refused. All of this was verified against a running dev server.
- **Reveal**: Real values are returned only when `reveal: true` and the request is authenticated. Without a configured key, `authenticated` is always false.
- **Data exposure**: `raw` finding payloads and `openapiJson` are never returned. Redaction is applied to the whole output object, not to selected fields. If decryption fails, the tool returns an error; output that could not be redacted is never sent.
- **Prompt injection**: Evidence is wrapped as `{untrusted: true, source: "target-response"}` and capped at 2000 characters, and the tool descriptions tell the agent not to follow instructions found in it.
- **Accepted limitation** (agreed in the plan): only the site's current secret values are known, so a rotated-out token in an old scan is not redacted. This is documented in the README.

---

## Dependency Audit

| Package   | Advisory            | Severity | Path                                                    | Status                                            |
| --------- | ------------------- | -------- | ------------------------------------------------------- | ------------------------------------------------- |
| `esbuild` | GHSA-67mh-4wv8-2f99 | Moderate | `drizzle-kit > @esbuild-kit/core-utils > esbuild` (dev) | Pre-existing on `main`, not caused by this change |

The added packages (`@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/client@2.3.1` (dev)) have no known advisories.

---

## Remediation Priority

| Priority | Finding                     | Action                                                      |
| -------- | --------------------------- | ----------------------------------------------------------- |
| Done     | V-01                        | Fixed in this branch                                        |
| —        | esbuild (pre-existing, dev) | Out of scope for #16; track with the audit-ignore follow-up |
