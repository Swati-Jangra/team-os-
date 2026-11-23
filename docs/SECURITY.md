# Security review (Phase 7)

This is a **self-review** with automated regression tests, not an independent audit or penetration test. No external review has happened.

## Controls and how each is verified

| Area | Control | Verified by |
|---|---|---|
| Tenant isolation | Postgres RLS on every tenant table; app connects as `app_user` (NOBYPASSRLS); org/user/workspace come from the server-side session, never from client input | 84 DB tests (`*.rls.test.ts`), tenancy e2e tests; **production boot refuses a superuser/`migrator` DB role** (`config` tests) |
| AuthN | argon2id, server-side sessions (hashed token), lockout, single-use hashed email/reset tokens, per-route rate limits | `auth.e2e.test.ts`; route inventory test asserts every credential endpoint is rate limited |
| AuthZ | Guards: rate limit → auth(+CSRF) → tenant → permission. Permission on every org route | **Route inventory test** (`hardening.e2e.test.ts`): the exact list of public routes is pinned; org routes without `@RequirePermission` are snapshotted (only the caller's own notifications + SSE stream). Adding a route without a decision fails the build. |
| CSRF | Double-submit token required on all mutations; CORS limited to `APP_URL` | hardening test (wrong token → 403; CORS never reflects another origin) |
| Transport | helmet on the API; web adds CSP, HSTS (prod), `X-Frame-Options: DENY`, `Permissions-Policy`, COOP; cookies `HttpOnly`, `SameSite=Lax`, `Secure` in prod | headers tested on the API; web headers verified on the production standalone build (and the login/register pages render with **0 CSP violations**) |
| Secrets | none in the repo; `.env.example` placeholders only; integration tokens AES-256-GCM with per-row AAD; never returned by an endpoint or logged; metrics/log labels are route templates only | integrations/google e2e tests (ciphertext in DB, token never in the page), metrics test (no ids/emails in `/metrics`) |
| Input | zod validation on every body/query/param; JSON body limit 1 MB, audio 25 MB; uniform error envelope with no stack traces | hardening test (413 envelope without internals) |
| Webhooks | HMAC-SHA256 over the raw body, constant-time compare, per-delivery idempotency, uniform 404 | integrations e2e |
| AI | AI output is proposals only; every business-critical write needs a human approval with `approval:decide`; approvals are atomic and single-use | agents/meetings/google e2e (including concurrent approvals) |
| Observability endpoints | `/metrics` bearer token (constant-time compare), 404 when unset; worker port is private | API + worker tests |
| Mail | production requires STARTTLS/TLS and supports SMTP auth | `mailer.test.ts` |
| Supply chain | `pnpm audit --prod`: **55 → 0** known findings (see below) | CI runs the audit on each build |

## Dependency audit

`pnpm audit --prod` reports **no known vulnerabilities** (was 55 at the start of Phase 7). Done in two steps:
minor-compatible upgrades and pinned patched transitive versions (root `pnpm.overrides`: `body-parser`, `qs`, `multer`, `postcss`; `nodemailer` 6→10, `kysely` 0.27→0.28, `sanitize-html`), then the three major upgrades:
**NestJS 10→11** (Express 5), **zod 3→4**, **Tiptap 2→3**. Code changes were small (zod pipe/helper type signatures, Tiptap `setContent` options and StarterKit's bundled Link);
all 441 tests and the 8 browser E2E specs pass on the upgraded stack. The audit covers production dependencies only and only advisories known to the registry at the time of the run (2026-11-22); re-run it in CI (`pnpm audit --prod`, currently set to fail on *critical*).

## Known gaps (honest list)

1. CSP uses `script-src 'unsafe-inline'` (Next.js inline bootstrap); a nonce policy would force dynamic rendering of every page.
2. No independent penetration test, no fuzzing, no automated DAST/SAST in CI beyond `pnpm audit`.
3. No MFA/SSO/SAML; no password breach check; session list/revoke exists, but no suspicious-login alerts.
4. No encryption at rest beyond what the database/volume provides; integration tokens are encrypted at the application level only.
5. `INTEGRATION_ENCRYPTION_KEY` has no rotation procedure (single key).
6. Audit logs are append-only in the database but are not shipped to an external immutable store.
7. No per-organization rate limits or quotas (only per-IP and a few per-user limits); a single noisy tenant can use shared capacity.
8. Dev-only dependencies are not audited.
9. No WAF; DDoS protection is the operator's job (CDN/WAF in front of Caddy).
