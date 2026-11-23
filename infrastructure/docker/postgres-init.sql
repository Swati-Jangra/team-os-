-- Creates the two roles described in ARCHITECTURE.md (D2).
-- migrator owns the schema; app_user is subject to RLS (no BYPASSRLS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'migrator') THEN
    CREATE ROLE migrator LOGIN PASSWORD 'migrator_password' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT ALL PRIVILEGES ON DATABASE teamos TO migrator;
GRANT CONNECT ON DATABASE teamos TO app_user;
ALTER DATABASE teamos OWNER TO migrator;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
