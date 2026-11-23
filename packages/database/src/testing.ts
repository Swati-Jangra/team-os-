import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { createDb, type Database } from './client';
import { runMigrations } from './migrate';
import { seedSystemRoles } from './seed';

export interface TestDatabase {
  name: string;
  /** Connected as app_user (subject to RLS) — what the application uses. */
  db: Database;
  /** Connected as migrator (schema owner, bypasses RLS) — fixtures and assertions only. */
  admin: Database;
  appUrl: string;
  migratorUrl: string;
  destroy(): Promise<void>;
}

const ADMIN_URL = () =>
  process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres@localhost:5432/postgres';

function urlFor(base: string, user: string, password: string, dbName: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Creates an isolated, fully migrated + seeded database for tests, with the same two-role
 * setup as production (migrator owns the schema, app_user is RLS-constrained).
 * Requires a reachable Postgres superuser via TEST_ADMIN_DATABASE_URL.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = ADMIN_URL();
  const name = `teamos_test_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock(424242)');
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='migrator') THEN
        CREATE ROLE migrator LOGIN PASSWORD 'migrator_password' CREATEDB; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_user') THEN
        CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOBYPASSRLS; END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${name} OWNER migrator`);
    await admin.query('SELECT pg_advisory_unlock(424242)');
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO app_user`);
  } finally {
    await admin.end();
  }

  const migratorUrl = urlFor(adminUrl, 'migrator', 'migrator_password', name);
  const appUrl = urlFor(adminUrl, 'app_user', 'app_password', name);
  await runMigrations(migratorUrl);
  const adminDb = createDb(migratorUrl, { max: 3 });
  await seedSystemRoles(adminDb);
  const db = createDb(appUrl, { max: 5 });

  return {
    name,
    db,
    admin: adminDb,
    appUrl,
    migratorUrl,
    async destroy() {
      await db.destroy();
      await adminDb.destroy();
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
