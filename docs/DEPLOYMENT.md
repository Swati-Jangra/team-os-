# Deployment and operations runbook

**Status of this document:** the artifacts here (Dockerfile, `docker-compose.prod.yml`, Caddyfile, scripts) were written
and their *contents* verified step by step without Docker (build, `pnpm deploy --prod` bundles booted with `node dist/main.js`,
Next.js standalone output served with its headers, backup → restore round trip). **The container images themselves were never
built or run** — there is no Docker daemon in the authoring environment. Do a first deploy to a staging host before production.

## Topology (single host)

```
internet ─► Caddy :443 (TLS, gzip, SSE-safe) ─┬─► /api/*  → api:4000   (NestJS, stateless)
                                              └─► /*      → web:3000   (Next.js standalone)
api ──► Postgres (app_user, RLS)   ──► Redis (rate limits, realtime pub/sub, BullMQ)
worker ─► same Postgres/Redis; outbox relay, queues, schedulers; health/metrics on :4100 (private only)
migrate: one-shot job (schema owner `migrator`) that applies SQL migrations and seeds system roles
```

* API and worker **must share the `storage` volume** (meeting audio) → they must run on the same host. Moving to multiple hosts
  needs object storage first (not implemented; see gaps).
* `/metrics` (API) is outside `/api/` and the worker port is not published, so neither is reachable from the internet.
  Scrape them from the private network with the `METRICS_TOKEN` bearer token.
* The browser only talks to one origin (Caddy). The web app proxies nothing sensitive; session cookies are `Secure`, `HttpOnly`, `SameSite=Lax`.

## First deploy

1. DNS `A` record for `DOMAIN` → the host. Open ports 80/443 only.
2. `cp .env.production.example .env.production` and fill it in. Generate secrets:
   `openssl rand -base64 48` (AUTH_SECRET), `openssl rand -base64 32` (INTEGRATION_ENCRYPTION_KEY), `openssl rand -hex 24` (passwords, METRICS_TOKEN).
   Store the file in a secret manager / root-only file. **Never commit it.** Back up `INTEGRATION_ENCRYPTION_KEY` separately: without it every stored OAuth token is unreadable and integrations must be reconnected.
3. `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`
4. Check: `curl https://$DOMAIN/api/v1/health/ready` → `{"data":{"status":"ready",...}}`.
5. The API **refuses to start** in production if: URLs are not https, `AUTH_SECRET` looks like a placeholder, `DATABASE_URL` connects as a superuser/`migrator`
   (RLS would be bypassed), `AI_PROVIDER=local` without `ALLOW_LOCAL_AI=true`, OpenAI has no key, or SMTP is `localhost`. Fix the printed list.
6. Register the first user in the UI and create the organization.

## Upgrades

1. **Back up first** (`scripts/ops/backup.sh`). Migrations are forward-only SQL; rollback of schema = restore the backup.
2. `git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build` — the `migrate` job runs before `api`/`worker` start.
3. Migrations are additive where possible. Migration 0011 rewrites every workspace RLS policy (safe, asserted in-migration, covered by tests).
   Migration 0012 builds indexes non-concurrently (brief write lock on `tasks`); on a very large table, create them `CONCURRENTLY` by hand first.
4. Verify `/api/v1/health/ready`, then watch `teamos_http_requests_total{status="5xx"}` and `teamos_outbox_oldest_pending_seconds` for 10 minutes.

## Backup and restore

* `DIRECT_URL=postgresql://migrator:...@host/teamos STORAGE_DIR=/path/to/storage ./scripts/ops/backup.sh ./backups` — custom-format dump + audio tarball; the script lists the archive to prove it is readable.
* Prove a backup works: `ADMIN_URL=postgresql://postgres:...@host/postgres ./scripts/ops/restore-check.sh backups/teamos-<ts>.dump` restores into a throw-away database and prints row counts, RLS-enabled table count and recorded migrations.
  (Verified here: 38 RLS tables, 12 migrations after restore.) Schedule both (cron/systemd timer), ship dumps off-host, and test a restore monthly.
* Redis holds only rate-limit counters, realtime pub/sub and BullMQ jobs. Unpublished outbox events live in Postgres, so a Redis loss delays but does not lose events
  (queued-but-unprocessed BullMQ jobs are re-derived only if the outbox row is still unpublished; jobs already handed to BullMQ are lost with Redis — AOF is enabled in the compose file to limit this).

## Monitoring

| Endpoint | Where | Use |
|---|---|---|
| `GET /api/v1/health/live` | API (public) | liveness: process answers, never touches dependencies |
| `GET /api/v1/health/ready` | API (public) | readiness: Postgres + Redis; 503 when either is down |
| `GET /metrics` | API, bearer `METRICS_TOKEN`, 404 if unset | request count/latency by **route template**, Node process metrics |
| `GET :4100/health/live`, `/health/ready`, `/metrics` | worker, private | queue depth per state, job outcomes, outbox backlog and lag |

Access logs: one JSON line per request (`ts, level, requestId, method, route, status, ms, userId, orgId`) — route templates, never URLs, query strings, bodies or tokens.
Every response carries `X-Request-Id`; error bodies include it, so a user report maps to a log line.

Prometheus scrape example:

```yaml
scrape_configs:
  - job_name: teamos-api
    metrics_path: /metrics
    authorization: { type: Bearer, credentials_file: /etc/prometheus/teamos-metrics-token }
    static_configs: [{ targets: ["api:4000"] }]
  - job_name: teamos-worker
    metrics_path: /metrics
    authorization: { type: Bearer, credentials_file: /etc/prometheus/teamos-metrics-token }
    static_configs: [{ targets: ["worker:4100"] }]
```

Suggested alerts (thresholds are starting points, **not tuned on production traffic**):

* `teamos_outbox_oldest_pending_seconds > 120` for 5 min — the relay is stuck (events not leaving Postgres).
* `teamos_queue_jobs{queue="dead-letter",state="waiting"} > 0` — jobs exhausted their retries; inspect and replay.
* `teamos_queue_jobs{state="failed"}` rising, or `teamos_queue_jobs{state="waiting"}` growing for 10 min — a worker is down or slow.
* `rate(teamos_http_requests_total{status="5xx"}[5m]) / rate(teamos_http_requests_total[5m]) > 0.02`.
* `histogram_quantile(0.95, rate(teamos_http_request_duration_seconds_bucket[5m])) > 1`.
* readiness failing for 2 min (`/health/ready` 503) — Postgres or Redis unreachable.
* `teamos_metrics_collect_errors_total` increasing — the worker cannot reach Redis/Postgres.

Error tracking: `SENTRY_DSN` exists in the config but **no Sentry SDK is wired** (see gaps).

## Operating notes

* **Scaling**: the API is stateless (sessions in Postgres, rate limits/realtime in Redis) and can run N replicas behind Caddy/another LB; set `trust proxy` hops accordingly. Run **one** worker unless the audio volume is shared; BullMQ and the outbox claim (`FOR UPDATE SKIP LOCKED`) are safe with several.
* **Rate limit**: `GLOBAL_RATE_LIMIT_PER_MINUTE` (default 600/IP/min). Behind NAT or a proxy, make sure the real client IP reaches the API (`X-Forwarded-For` from Caddy; `trust proxy` is 1 hop in production).
* **Rotating `AUTH_SECRET`**: sessions are server-side rows; rotating the secret does not log users out unless it keys something you rely on — verify on staging.
* **Rotating `INTEGRATION_ENCRYPTION_KEY`**: not supported (single key, no key id in the ciphertext envelope beyond `v1`). Rotating = disconnect and reconnect all integrations. See gaps.
* **Removing a user's data / offboarding**: soft deletes plus append-only audit logs; there is no automated GDPR erase/export tool.

## Known gaps (honest list)

1. Docker images/compose were not built or executed here; first run on a staging host.
2. No Sentry/OpenTelemetry tracing; metrics and logs only.
3. Meeting audio is on a local volume (single host). No S3/MinIO adapter despite MinIO being in the dev compose.
4. No key rotation for `INTEGRATION_ENCRYPTION_KEY`; no automated secret management integration.
5. No horizontal-scale test, no soak test, no chaos test; the load numbers in `docs/PERFORMANCE.md` come from one sandbox machine.
6. The bundled Postgres/Redis are single instances without replication or automated failover; use managed services for HA.
7. Nonce-based CSP is not implemented (`script-src 'unsafe-inline'` because Next.js inlines bootstrap scripts).
8. No WAF / DDoS protection beyond per-IP rate limits; put the service behind a CDN/WAF for public exposure.
9. Retention: the nightly cleanup removes expired sessions/email tokens, processed-event markers (30 d), published outbox rows (14 d) and read notifications (90 d). `audit_logs` are append-only and **never deleted** — there is no retention/archival policy or partitioning yet; plan for table growth (≈1 row per mutation).
