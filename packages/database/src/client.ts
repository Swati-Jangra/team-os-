import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool, types } from 'pg';
import type { DB } from './types';

// Keep bigint/numeric parsing predictable; timestamps are parsed to Date by pg by default.
types.setTypeParser(20, (v) => Number(v)); // int8 -> number (counts)
// `date` columns stay as 'YYYY-MM-DD' strings; the default Date parse shifts by the server timezone.
types.setTypeParser(1082, (v) => v);

export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;

export interface DbOptions {
  /** Max pooled connections (default 10). */
  max?: number;
}

export function createDb(connectionString: string, opts: DbOptions = {}): Database {
  const pool = new Pool({ connectionString, max: opts.max ?? 10 });
  // An idle pooled connection can be killed by the server (restart, failover, admin action). Without a
  // listener, pg re-throws that as an uncaught exception and takes the whole process down; the pool simply
  // discards the dead client and opens a new one on demand.
  pool.on('error', (err) => {
    if (process.env.NODE_ENV !== 'test') console.error(`[db] idle connection error: ${err.message}`);
  });
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    // JSONB documents keep their stored key names (third-party payloads are snake_case); only column names are mapped
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  });
}

/**
 * Server-validated tenant context. Values are applied with `set_config(..., true)`
 * (transaction-local), so they can never leak to another request on a pooled
 * connection. NEVER build this from browser-supplied ids without validating them first.
 */
export interface TenantContext {
  userId?: string | null;
  orgId?: string | null;
  workspaceId?: string | null;
}

/** Runs `fn` in a transaction with the RLS context set. All tenant data access must go through this. */
export async function withContext<T>(
  db: Database,
  ctx: TenantContext,
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT
      set_config('app.user_id', ${ctx.userId ?? ''}, true),
      set_config('app.org_id', ${ctx.orgId ?? ''}, true),
      set_config('app.workspace_id', ${ctx.workspaceId ?? ''}, true)`.execute(trx);
    return fn(trx);
  });
}

export { sql };
