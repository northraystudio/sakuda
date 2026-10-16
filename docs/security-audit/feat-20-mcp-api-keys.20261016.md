# Security Audit: feat/20-mcp-api-keys — 2026-10-16

> Scope: `server/mcp`, `server/services/mcpKeyService.ts`, `server/domain/mcpKey.ts`, `server/api/mcp-keys`, `server/routes/mcp.ts`, `server/config/env.ts`, `server/plugins/00.boot.ts`, `app/pages/mcp-keys.vue`, `shared/utils/claudeMcpCommand.ts`, `shared/schemas/mcpKey.ts` | Stack: TypeScript / Nuxt 4 (Nitro, h3) / drizzle + SQLite | Auditor: Claude vulnerability-scan skill | Baseline: `main`
> Read-only inspection — no code was modified.

---

## Executive Summary

The change replaces the env-configured MCP key with DB-issued keys (sha256 only) managed from the UI. No true-positive vulnerability was found: key management is loopback-only, keys have 256 bits of entropy, plaintext appears only in the one-time issue/reissue response (`no-store`), and revocation takes effect on the next request. No dependency changed.

**Critical/High findings requiring immediate action:** 0
**Total findings:** 0 true positives | 0 false positives discarded

---

## Pre-Scan Context

- **Trust boundaries**: `/mcp` (MCP clients over loopback HTTP), `/api/mcp-keys*` (the sakuda UI in the operator's browser).
- **Authentication model**: optional Bearer API key for `/mcp` only; the rest of the REST API is unauthenticated loopback (out of scope for #20 by design).
- **Data sensitivity**: an MCP key unlocks `reveal: true`, i.e. decrypted site secrets (auth headers, cookies, storage values).
- **Deployment**: single-operator local tool, bound to loopback; DNS rebinding is the realistic remote vector.

## Automated Scan

`semgrep --config p/security-audit --config p/owasp-top-ten --config p/typescript` (the CI gate rulesets) on the scope above: 18 files scanned, **0 results**, 0 errors.

## Manual Review

| Area                                   | Observation                                                                                                                                                                                                                                                                                         | Result                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| DNS rebinding / CSRF on key management | All four routes call `requireLoopbackRequest` first (`server/api/mcp-keys/index.post.ts:13`, `[id]/reissue.post.ts:12`, `[id].delete.ts:9`, `index.get.ts:9`). POST bodies go through `parseBody`, which rejects non-JSON content types (no simple-request form CSRF); DELETE requires a preflight. | OK                     |
| Order of checks on `/mcp`              | Host/Origin is checked before any key logic (`server/mcp/auth.ts:18`).                                                                                                                                                                                                                              | OK                     |
| Revocation semantics                   | A request that sends `Authorization` is always validated, even with zero keys (`server/mcp/auth.ts:23-28`), so the last revoked key is 401, not silently downgraded to unauthenticated.                                                                                                             | OK                     |
| Key entropy / generation               | `randomBytes(32)` → base64url (`server/domain/mcpKey.ts:9`): 256-bit CSPRNG.                                                                                                                                                                                                                        | OK                     |
| Storage                                | Only `sha256(key)` is stored (`server/domain/mcpKey.ts:16`); a fast hash is appropriate for a high-entropy random token (no dictionary/brute-force surface). Verified on a live DB dump: no plaintext.                                                                                              | OK                     |
| Comparison timing                      | Lookup by indexed hash equality (`server/services/mcpKeyService.ts:72`); timing can at most reveal hash prefixes, which gives no useful preimage information for a 256-bit key.                                                                                                                     | OK                     |
| SQL injection                          | drizzle query builder with bound parameters only.                                                                                                                                                                                                                                                   | OK                     |
| Exposure in responses                  | List returns `{id,label,createdAt}` only; issue/reissue responses carry the key once with `cache-control: no-store` (`index.post.ts:14`, `reissue.post.ts:13`).                                                                                                                                     | OK                     |
| Logging                                | Logs carry `operation` + `mcpKeyId` only; the retired-env warning names the variable, never its value (`server/plugins/00.boot.ts:23`). Verified on a live dev log.                                                                                                                                 | OK                     |
| XSS                                    | Label and key rendered via Vue interpolation (escaped); no `v-html`.                                                                                                                                                                                                                                | OK                     |
| Client state                           | The shown key is cleared at the start of the next action (`app/pages/mcp-keys.vue:30`) and lives only in component state.                                                                                                                                                                           | OK                     |
| Retired env var                        | A leftover `SAKUDA_MCP_API_KEY` no longer gates `/mcp`; boot warns. With zero issued keys `/mcp` is keyless loopback and `reveal` is refused, so secrets are not exposed by the downgrade.                                                                                                          | Accepted (agreed plan) |

## False Positives

None.

## Dependency Audit

No dependency was added or changed (`package.json` / `pnpm-lock.yaml` identical to `main`). `pnpm audit` results are pre-existing on `main` and covered by ADR 0001 (dev/build-only advisories). No new Critical/High CVE.

## Remediation Priority

None required.
