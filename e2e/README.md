# Browser end-to-end tests

Playwright scripts (plain Node, no test runner) that drive the real web UI against the real API, worker, Postgres and Redis.
Third-party services are replaced by local mocks in `e2e/mocks/` (GitHub, Google OAuth/Calendar/Gmail, an SMTP sink), so these tests prove
**our** integration code, not that the real providers behave the same.

```
ALLOW_HTTP=1 pnpm build        # the production web build, without HSTS/upgrade-insecure-requests (E2E serves plain http)
export DATABASE_URL=postgresql://app_user:...@localhost:5432/teamos     # app role (RLS)
export DIRECT_URL=postgresql://migrator:...@localhost:5432/teamos       # schema owner
export REDIS_URL=redis://localhost:6379
pnpm db:migrate
./e2e/stack.sh start
E2E_DATABASE_URL=$DIRECT_URL ./e2e/run.sh        # all specs; or ./e2e/run.sh github
./e2e/stack.sh stop
```

Specs (each creates fresh users/orgs, so they can run repeatedly against one database): 01 auth/org/members · 02 projects/tasks ·
03 notifications/realtime · 04 documents/knowledge/meetings · 05 AI plan/risk/agents · 06 approvals · 07 GitHub · 08 Google Calendar + Gmail.
Screenshots go to `e2e/out/shots`. The mock servers keep state in memory; restart the stack to reset them (spec 08 expects a fresh mock-google).
