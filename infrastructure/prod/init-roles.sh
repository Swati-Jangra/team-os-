#!/bin/sh
# Runs once, on first start of the bundled Postgres container (docker-entrypoint-initdb.d).
# Creates the two roles from ARCHITECTURE.md: `migrator` owns the schema; `app_user` is subject to RLS.
# Passwords come from the environment — nothing is hard-coded.
set -eu
: "${MIGRATOR_DB_PASSWORD:?set MIGRATOR_DB_PASSWORD}" "${APP_DB_PASSWORD:?set APP_DB_PASSWORD}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_pw="$MIGRATOR_DB_PASSWORD" -v app_pw="$APP_DB_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE app_user LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE :"db" TO app_user;
ALTER DATABASE :"db" OWNER TO migrator;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
