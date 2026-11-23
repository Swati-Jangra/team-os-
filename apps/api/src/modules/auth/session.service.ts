import { Inject, Injectable } from '@nestjs/common';
import { hmacSha256Hex, randomToken } from '@teamos/shared';
import { DbService } from '../../db/db.service';
import { APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../common/app-config';
import type { AuthedUser } from '../../common/express.d';

export const SESSION_COOKIE = 'teamos_session';
export const CSRF_COOKIE = 'teamos_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const TOUCH_INTERVAL_MS = 60_000;

@Injectable()
export class SessionService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  hashToken(token: string): string {
    return hmacSha256Hex(token, this.config.authSecret);
  }

  /** Opaque 256-bit token; only its keyed hash is stored. */
  async create(
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 3_600_000);
    await this.dbs.db
      .insertInto('sessions')
      .values({
        userId,
        tokenHash: this.hashToken(token),
        csrfToken,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        expiresAt,
      })
      .execute();
    return { token, csrfToken, expiresAt };
  }

  async validate(token: string): Promise<AuthedUser | null> {
    const session = await this.dbs.db
      .selectFrom('sessions')
      .select(['id', 'userId', 'csrfToken', 'lastUsedAt'])
      .where('tokenHash', '=', this.hashToken(token))
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();
    if (!session) return null;

    // users is RLS-protected: resolve under the session owner's own context
    const user = await this.dbs.run({ userId: session.userId }, (trx) =>
      trx
        .selectFrom('users')
        .select(['id', 'email', 'name'])
        .where('id', '=', session.userId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst(),
    );
    if (!user) return null;

    if (Date.now() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.dbs.db.updateTable('sessions').set({ lastUsedAt: new Date() }).where('id', '=', session.id).execute();
    }
    return { userId: user.id, sessionId: session.id, csrfToken: session.csrfToken, email: user.email, name: user.name };
  }

  async revoke(sessionId: string, userId: string): Promise<boolean> {
    const r = await this.dbs.db
      .updateTable('sessions')
      .set({ revokedAt: new Date() })
      .where('id', '=', sessionId)
      .where('userId', '=', userId)
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    let q = this.dbs.db
      .updateTable('sessions')
      .set({ revokedAt: new Date() })
      .where('userId', '=', userId)
      .where('revokedAt', 'is', null);
    if (exceptSessionId) q = q.where('id', '!=', exceptSessionId);
    await q.execute();
  }

  async listActive(userId: string) {
    return this.dbs.db
      .selectFrom('sessions')
      .select(['id', 'ip', 'userAgent', 'createdAt', 'lastUsedAt', 'expiresAt'])
      .where('userId', '=', userId)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .orderBy('lastUsedAt', 'desc')
      .execute();
  }
}
