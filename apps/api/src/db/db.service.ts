import { Inject, Injectable } from '@nestjs/common';
import { withContext, type Database, type TenantContext, type Tx } from '@teamos/database';
import { DB } from '../common/tokens';

/**
 * The only way application code touches tenant data: every call runs inside a transaction with
 * the RLS context set. `db` (raw) is for tables without RLS (sessions, email_tokens) only.
 */
@Injectable()
export class DbService {
  constructor(@Inject(DB) readonly db: Database) {}

  run<T>(ctx: TenantContext, fn: (trx: Tx) => Promise<T>): Promise<T> {
    return withContext(this.db, ctx, fn);
  }
}
