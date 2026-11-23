#!/usr/bin/env bash
# Starts / stops everything the browser E2E needs, from the BUILT artifacts (run `pnpm build` first):
# SMTP sink :1025, mock GitHub :4510, mock Google :4520, API :4000, worker, web :3000.
# Requires: Postgres + Redis already running and migrated; DATABASE_URL (app_user), DIRECT_URL (migrator), REDIS_URL in the environment.
set -euo pipefail
cd "$(dirname "$0")/.."
run="$(pwd)/e2e/.run"; mkdir -p "$run"
case "${1:-}" in
  start)
    : "${DATABASE_URL:?}" "${DIRECT_URL:?}" "${REDIS_URL:?}"
    export AUTH_SECRET="${AUTH_SECRET:-$(openssl rand -base64 48)}"
    export INTEGRATION_ENCRYPTION_KEY="$(openssl rand -base64 32)"
    export APP_URL=http://localhost:3000 API_URL=http://localhost:4000 API_PORT=4000 SMTP_HOST=localhost SMTP_PORT=1025
    export GLOBAL_RATE_LIMIT_PER_MINUTE=100000 RATE_LIMIT_MULTIPLIER=1000   # specs register dozens of users from one IP WORKER_HTTP_PORT=4100
    export GITHUB_CLIENT_ID=cid GITHUB_CLIENT_SECRET=csecret GITHUB_API_URL=http://localhost:4510 GITHUB_OAUTH_URL=http://localhost:4510
    export GOOGLE_CLIENT_ID=gid GOOGLE_CLIENT_SECRET=gsecret GOOGLE_AUTH_URL=http://localhost:4520/auth GOOGLE_TOKEN_URL=http://localhost:4520/token GOOGLE_REVOKE_URL=http://localhost:4520/revoke GOOGLE_CALENDAR_API_URL=http://localhost:4520/calendar/v3 GMAIL_API_URL=http://localhost:4520/gmail/v1
    mkdir -p e2e/out
    node e2e/mocks/smtp-sink.js > e2e/out/smtp.log 2>&1 & echo $! >> "$run/pids"   # specs count delivered mails from this log
    for m in mock-github mock-google; do node "e2e/mocks/$m.js" > "$run/$m.log" 2>&1 & echo $! >> "$run/pids"; done
    node apps/api/dist/main.js > "$run/api.log" 2>&1 & echo $! >> "$run/pids"
    node apps/worker/dist/main.js > "$run/worker.log" 2>&1 & echo $! >> "$run/pids"
    (cd apps/web && API_URL=http://localhost:4000 PORT=3000 pnpm exec next start -p 3000 > "$run/web.log" 2>&1 & echo $! >> "$run/pids")
    for i in $(seq 1 60); do curl -fs localhost:3000/api/v1/health/ready >/dev/null 2>&1 && { echo "stack up"; exit 0; }; sleep 1; done
    echo "stack failed to start; see $run/*.log" >&2; tail -n 20 "$run"/api.log >&2; exit 1 ;;
  stop)
    [ -f "$run/pids" ] && xargs -r kill < "$run/pids" 2>/dev/null || true
    rm -f "$run/pids" ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
