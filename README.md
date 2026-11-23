# TeamOS AI

Multi-tenant AI work OS. **Status: Phases 1–3 complete; Phase 4 done (documents, knowledge search, meetings with approval, AI planning). Phase 5 done (risk center, agent proposals, approval workflow). Phase 6 done (GitHub, Google Calendar, Gmail — mock-tested only); Phase 7 done (hardening, performance, monitoring, deployment artifacts — Docker images not yet built/run)** — see `docs/PROJECT_STATUS.md` for what is and isn't done.

## Requirements
Node 20+, pnpm 10, PostgreSQL 16, Redis 7 (docker-compose provides these plus Mailpit and MinIO — compose file is untested).

## Setup
```bash
cp .env.example .env          # fill AUTH_SECRET (32+ chars) etc.
pnpm install
# Postgres needs roles `migrator` (owner) and `app_user` (NOBYPASSRLS): see infrastructure/docker/postgres-init.sql
pnpm db:migrate && pnpm db:seed
pnpm dev                      # web :3000, api :4000, worker
```
The web app proxies `/api/v1/*` to `API_URL`, so cookies and CSRF stay same-origin.

## AI configuration
By default an offline `local` provider is used (development only: lexical search, quoted answers). For real answers set `AI_PROVIDER=openai` and `OPENAI_API_KEY` (optionally `OPENAI_BASE_URL`, `OPENAI_CHAT_MODEL`, `OPENAI_EMBEDDING_MODEL`). Never commit keys.

## Scripts
`pnpm typecheck` · `pnpm test` (DB tests create throwaway databases via `TEST_ADMIN_DATABASE_URL`, default `postgresql://postgres@localhost:5432/postgres`) · `pnpm build`

## Docs
`docs/ARCHITECTURE.md` · `docs/API.md` · `docs/PROJECT_STATUS.md`

## Operations
- Deploy / run book: `docs/DEPLOYMENT.md` · Security review: `docs/SECURITY.md` · Performance report: `docs/PERFORMANCE.md`
- Production stack: `docker-compose.prod.yml` + `.env.production.example` (copy, fill in, never commit)- Tests: `pnpm test` (unit/integration), `pnpm lint`, browser E2E in `e2e/README.md`; route index in `docs/ROUTES.md`
