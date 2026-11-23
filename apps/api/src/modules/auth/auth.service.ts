import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type MemberRole } from '@teamos/database';
import { AppError, normalizeEmail } from '@teamos/shared';
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from '@teamos/validation';
import { APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../common/app-config';
import type { UserActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { EmailTokenService } from './email-token.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

interface LoginRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface LoginResult {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  user: { id: string; email: string; name: string };
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(EmailTokenService) private readonly emailTokens: EmailTokenService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Always answers the same way, whether or not the email already exists, so the endpoint can't be
   * used to enumerate accounts. Existing accounts silently get no new user row.
   */
  async register(input: RegisterInput, meta: { requestId: string; ip: string | null }): Promise<{ status: 'verification_sent' }> {
    const email = normalizeEmail(input.email);
    const id = randomUUID();
    const passwordHash = await this.passwords.hash(input.password);
    try {
      await this.dbs.run({ userId: id }, async (trx) => {
        await trx.insertInto('users').values({ id, email, name: input.name, passwordHash }).execute();
        const token = await this.emailTokens.issue(trx, id, 'VERIFY_EMAIL', this.config.emailTokenTtlMinutes);
        await this.outbox.enqueue(trx, 'user.registered.v1', { userId: id, email, name: input.name });
        await this.outbox.enqueue(trx, 'user.email_verification_requested.v1', { userId: id, email, token });
        await this.audit.record(trx, {
          actorType: 'USER',
          actorId: id,
          action: 'auth.registered',
          targetType: 'user',
          targetId: id,
          requestId: meta.requestId,
          ip: meta.ip,
        });
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    return { status: 'verification_sent' };
  }

  async verifyEmail(input: VerifyEmailInput, meta: { requestId: string; ip: string | null }): Promise<{ verified: true }> {
    const tok = await this.emailTokens.peek('VERIFY_EMAIL', input.token);
    if (!tok) throw new AppError('TOKEN_INVALID');
    await this.dbs.run({ userId: tok.userId }, async (trx) => {
      if (!(await this.emailTokens.consume(trx, tok.id))) throw new AppError('TOKEN_INVALID');
      await trx
        .updateTable('users')
        .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
        .where('id', '=', tok.userId)
        .where('emailVerifiedAt', 'is', null)
        .execute();
      await this.audit.record(trx, {
        actorType: 'USER',
        actorId: tok.userId,
        action: 'auth.email_verified',
        targetType: 'user',
        targetId: tok.userId,
        requestId: meta.requestId,
        ip: meta.ip,
      });
    });
    return { verified: true };
  }

  async login(
    input: LoginInput,
    meta: { requestId: string; ip: string | null; userAgent: string | null },
  ): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const found = await this.dbs.run({}, (trx) =>
      sql<LoginRow>`SELECT id, email, name, password_hash, email_verified_at, failed_login_count, locked_until
                    FROM auth_find_user_by_email(${email})`.execute(trx),
    );
    const user = found.rows[0];

    if (!user) {
      await this.passwords.verifyDummy(input.password);
      throw new AppError('INVALID_CREDENTIALS');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AppError('RATE_LIMITED', 'Account temporarily locked after repeated failed sign-ins', {
        retryAfterSec: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000),
      });
    }

    const ok = await this.passwords.verify(user.passwordHash, input.password);
    if (!ok) {
      await this.recordFailedLogin(user.id, meta);
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (!user.emailVerifiedAt) throw new AppError('EMAIL_NOT_VERIFIED');

    await this.dbs.run({ userId: user.id }, async (trx) => {
      await trx
        .updateTable('users')
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where('id', '=', user.id)
        .execute();
      await this.audit.record(trx, {
        actorType: 'USER',
        actorId: user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        requestId: meta.requestId,
        ip: meta.ip,
      });
    });

    const session = await this.sessions.create(user.id, { ip: meta.ip, userAgent: meta.userAgent });
    return { ...session, user: { id: user.id, email: user.email, name: user.name } };
  }

  private async recordFailedLogin(userId: string, meta: { requestId: string; ip: string | null }): Promise<void> {
    await this.dbs.run({ userId }, async (trx) => {
      const row = await trx
        .updateTable('users')
        .set((eb) => ({ failedLoginCount: eb('failedLoginCount', '+', 1) }))
        .where('id', '=', userId)
        .returning('failedLoginCount')
        .executeTakeFirstOrThrow();
      const locked = row.failedLoginCount >= this.config.lockoutThreshold;
      if (locked) {
        await trx
          .updateTable('users')
          .set({
            failedLoginCount: 0,
            lockedUntil: new Date(Date.now() + this.config.lockoutMinutes * 60_000),
          })
          .where('id', '=', userId)
          .execute();
      }
      await this.audit.record(trx, {
        actorType: 'USER',
        actorId: userId,
        action: locked ? 'auth.account_locked' : 'auth.login_failed',
        targetType: 'user',
        targetId: userId,
        requestId: meta.requestId,
        ip: meta.ip,
      });
    });
  }

  async logout(sessionId: string, actor: UserActor): Promise<void> {
    await this.sessions.revoke(sessionId, actor.userId);
    await this.dbs.run({ userId: actor.userId }, (trx) =>
      this.audit.record(trx, {
        actorType: 'USER',
        actorId: actor.userId,
        action: 'auth.logout',
        targetType: 'session',
        targetId: sessionId,
        requestId: actor.requestId,
        ip: actor.ip,
      }),
    );
  }

  /** Always succeeds from the caller's view (no account enumeration). */
  async forgotPassword(input: ForgotPasswordInput, meta: { requestId: string; ip: string | null }): Promise<{ status: 'sent' }> {
    const email = normalizeEmail(input.email);
    const found = await this.dbs.run({}, (trx) =>
      sql<{ id: string }>`SELECT id FROM auth_find_user_by_email(${email})`.execute(trx),
    );
    const user = found.rows[0];
    if (user) {
      await this.dbs.run({ userId: user.id }, async (trx) => {
        const token = await this.emailTokens.issue(trx, user.id, 'PASSWORD_RESET', this.config.passwordResetTtlMinutes);
        await this.outbox.enqueue(trx, 'user.password_reset_requested.v1', { userId: user.id, email, token });
        await this.audit.record(trx, {
          actorType: 'USER',
          actorId: user.id,
          action: 'auth.password_reset_requested',
          targetType: 'user',
          targetId: user.id,
          requestId: meta.requestId,
          ip: meta.ip,
        });
      });
    }
    return { status: 'sent' };
  }

  async resetPassword(input: ResetPasswordInput, meta: { requestId: string; ip: string | null }): Promise<{ reset: true }> {
    const tok = await this.emailTokens.peek('PASSWORD_RESET', input.token);
    if (!tok) throw new AppError('TOKEN_INVALID');
    const passwordHash = await this.passwords.hash(input.password);
    await this.dbs.run({ userId: tok.userId }, async (trx) => {
      if (!(await this.emailTokens.consume(trx, tok.id))) throw new AppError('TOKEN_INVALID');
      await trx
        .updateTable('users')
        .set({
          passwordHash,
          failedLoginCount: 0,
          lockedUntil: null,
          // possession of the emailed token proves control of the address
          emailVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', tok.userId)
        .execute();
      // sign out everywhere
      await trx
        .updateTable('sessions')
        .set({ revokedAt: new Date() })
        .where('userId', '=', tok.userId)
        .where('revokedAt', 'is', null)
        .execute();
      await this.audit.record(trx, {
        actorType: 'USER',
        actorId: tok.userId,
        action: 'auth.password_reset',
        targetType: 'user',
        targetId: tok.userId,
        requestId: meta.requestId,
        ip: meta.ip,
      });
    });
    return { reset: true };
  }

  async me(userId: string): Promise<{
    user: { id: string; email: string; name: string };
    memberships: Array<{ organizationId: string; organizationName: string; organizationSlug: string; role: MemberRole }>;
  }> {
    return this.dbs.run({ userId }, async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select(['id', 'email', 'name'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      const memberships = await trx
        .selectFrom('organizationMembers as m')
        .innerJoin('organizations as o', 'o.id', 'm.organizationId')
        .select(['o.id as organizationId', 'o.name as organizationName', 'o.slug as organizationSlug', 'm.role'])
        .where('m.userId', '=', userId)
        .where('m.deletedAt', 'is', null)
        .where('o.deletedAt', 'is', null)
        .orderBy('o.name')
        .execute();
      return { user, memberships };
    });
  }
}
