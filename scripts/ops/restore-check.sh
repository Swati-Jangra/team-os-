#!/usr/bin/env bash
# Restores a dump into a THROWAWAY database and checks row counts + RLS state, to prove a backup is usable.
#   ADMIN_URL=postgresql://postgres:...@host/postgres ./scripts/ops/restore-check.sh backups/teamos-XXXX.dump
set -euo pipefail
: "${ADMIN_URL:?set ADMIN_URL to a superuser/createdb connection string (database: postgres)}"
dump="${1:?usage: restore-check.sh <dump>}"; db="teamos_restore_check_$$"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db" >/dev/null
trap 'psql "$ADMIN_URL" -c "DROP DATABASE IF EXISTS $db" >/dev/null' EXIT
target="${ADMIN_URL%/*}/$db"
pg_restore --no-owner --dbname "$target" "$dump"
psql "$target" -At -c "select 'users', count(*) from users union all select 'organizations', count(*) from organizations union all select 'tasks', count(*) from tasks union all select 'audit_logs', count(*) from audit_logs"
echo "tables with RLS enabled: $(psql "$target" -At -c "select count(*) from pg_class where relrowsecurity")"
echo "migrations recorded:    $(psql "$target" -At -c "select count(*) from schema_migrations")"
