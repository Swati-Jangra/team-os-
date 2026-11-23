import { Inject, Injectable } from '@nestjs/common';
import type { EmailTokenType, Tx } from '@teamos/database';
import { hmacSha256Hex, randomToken } from '@teamos/shared';
import { DbService } from '../../db/db.service';
import { APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../common/app-config';

/** Single-use, expiring tokens for email verification and password reset. Only keyed hashes are stored. */
@Injectable()
export class EmailTokenService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private hash(token: string): string {
    return hmacSha256Hex(token, this.config.authSecret);
  }

  async issue(trx: Tx, userId: string, type: EmailTokenType, ttlMinutes: number): Promise<string> {
    const token = randomToken(32);
    // supersede any earlier unused token of this type
    await trx
      .updateTable('emailTokens')
      .set({ usedAt: new Date() })
      .where('userId', '=', userId)
      .where('type', '=', type)
      .where('usedAt', 'is', null)
      .execute();
    await trx
      .insertInto('emailTokens')
      .values({
        userId,
        type,
        tokenHash: this.hash(token),
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      })
      .execute();
    return token;
  }

  /** Read-only lookup of a usable token's owner (token tables are looked up by secret, before user context exists). */
  async peek(type: EmailTokenType, token: string): Promise<{ id: string; userId: string } | null> {
    const row = await this.dbs.db
      .selectFrom('emailTokens')
      .select(['id', 'userId'])
      .where('tokenHash', '=', this.hash(token))
      .where('type', '=', type)
      .where('usedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();
    return row ?? null;
  }

  /** Atomically marks a token used inside the caller's transaction. False if it was already used/expired (race-safe). */
  async consume(trx: Tx, tokenId: string): Promise<boolean> {
    const r = await trx
      .updateTable('emailTokens')
      .set({ usedAt: new Date() })
      .where('id', '=', tokenId)
      .where('usedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }
}
