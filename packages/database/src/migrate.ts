import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/** Works from both src/ (tsx) and dist/ because both sit one level below the package root. */
export const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const LOCK_KEY = 727274;

/**
 * Applies pending `NNNN_name.sql` files in order, each in its own transaction, recorded in
 * `schema_migrations`. Must be run with the schema-owner (migrator) credentials.
 * Returns the names applied in this run.
 */
export async function runMigrations(connectionString: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sqlText = readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return applied;
}
