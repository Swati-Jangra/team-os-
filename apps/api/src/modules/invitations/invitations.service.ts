import { Inject, Injectable } from '@nestjs/common';
import { sql, type MemberRole } from '@teamos/database';
import { canInviteWithRole, type RoleName } from '@teamos/permissions';
import { AppError, hmacSha256Hex, normalizeEmail, randomToken } from '@teamos/shared';
import type { AcceptInvitationInput, CreateInvitationInput } from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import { APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../common/app-config';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';

interface InvitationRow {
  id: string;
  organizationId: string;
  email: string;
  role: MemberRole;
  workspaceIds: string[];
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private hash(token: string): string {
    return hmacSha256Hex(token, this.config.authSecret);
  }

  async create(actor: RequestActor, input: CreateInvitationInput) {
    if (input.role === 'OWNER') {
      // matches the DB constraint: ownership is only ever granted by promoting an existing member
      throw new AppError('FORBIDDEN', 'Ownership cannot be granted by invitation; promote an existing member instead');
    }
    if (!canInviteWithRole(actor.role, input.role as RoleName)) throw new AppError('FORBIDDEN');
    const email = input.email; // already trimmed + lowercased by the schema
    const workspaceIds = [...new Set(input.workspaceIds ?? [])];
    const token = randomToken(32);

    try {
      return await this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, async (trx) => {
        const org = await trx
          .selectFrom('organizations')
          .select('name')
          .where('id', '=', actor.orgId)
          .executeTakeFirstOrThrow();

        // refuse if the person is already an active member
        const existing = await trx
          .selectFrom('organizationMembers as m')
          .innerJoin('users as u', 'u.id', 'm.userId')
          .select('m.userId')
          .where('m.organizationId', '=', actor.orgId)
          .where('u.email', '=', email)
          .where('m.deletedAt', 'is', null)
          .executeTakeFirst();
        if (existing) throw new AppError('CONFLICT', 'This person is already a member of the organization');

        if (workspaceIds.length > 0) {
          const visible = await trx
            .selectFrom('workspaces')
            .select('id')
            .where('id', 'in', workspaceIds)
            .where('deletedAt', 'is', null)
            .execute();
          if (visible.length !== workspaceIds.length) throw new AppError('NOT_FOUND', 'One or more workspaces were not found');
        }

        // supersede an expired-but-unaccepted invite for the same address
        await trx
          .updateTable('invitations')
          .set({ revokedAt: new Date() })
          .where('organizationId', '=', actor.orgId)
          .where('email', '=', email)
          .where('acceptedAt', 'is', null)
          .where('revokedAt', 'is', null)
          .where('expiresAt', '<=', new Date())
          .execute();

        const inv = await trx
          .insertInto('invitations')
          .values({
            organizationId: actor.orgId,
            email,
            role: input.role as MemberRole,
            tokenHash: this.hash(token),
            invitedById: actor.userId,
            workspaceIds: sql`${workspaceIds}::uuid[]` as unknown as string[],
            expiresAt: new Date(Date.now() + this.config.invitationTtlDays * 86_400_000),
            acceptedAt: null,
            acceptedById: null,
            revokedAt: null,
          })
          .returning(['id', 'email', 'role', 'expiresAt', 'createdAt'])
          .executeTakeFirstOrThrow();

        await this.audit.record(
          trx,
          this.audit.forActor(actor, {
            action: 'invitation.created',
            targetType: 'invitation',
            targetId: inv.id,
            metadata: { email, role: input.role, workspaceIds },
          }),
        );
        await this.outbox.enqueue(
          trx,
          'member.invited.v1',
          {
            organizationId: actor.orgId,
            invitationId: inv.id,
            email,
            role: input.role,
            token,
            invitedByUserId: actor.userId,
            organizationName: org.name,
          },
          { orgId: actor.orgId },
        );
        return inv;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'A pending invitation already exists for this email');
      throw e;
    }
  }

  async list(actor: RequestActor) {
    return this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, (trx) =>
      trx
        .selectFrom('invitations')
        .select(['id', 'email', 'role', 'expiresAt', 'acceptedAt', 'revokedAt', 'createdAt'])
        .where('organizationId', '=', actor.orgId)
        .orderBy('createdAt', 'desc')
        .limit(200)
        .execute(),
    );
  }

  async revoke(actor: RequestActor, invitationId: string): Promise<void> {
    await this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, async (trx) => {
      const r = await trx
        .updateTable('invitations')
        .set({ revokedAt: new Date() })
        .where('id', '=', invitationId)
        .where('organizationId', '=', actor.orgId)
        .where('acceptedAt', 'is', null)
        .where('revokedAt', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new AppError('NOT_FOUND');
      await this.audit.record(
        trx,
        this.audit.forActor(actor, {
          action: 'invitation.revoked',
          targetType: 'invitation',
          targetId: invitationId,
        }),
      );
    });
  }

  /**
   * Accept as the signed-in user. The invitation must be pending, unexpired, and addressed to the
   * caller's own (verified) email; every failure is reported identically so tokens can't be probed.
   */
  async accept(user: UserActor & { email: string }, input: AcceptInvitationInput) {
    const found = await this.dbs.run({}, (trx) =>
      sql<InvitationRow>`SELECT id, organization_id, email, role, workspace_ids, expires_at, accepted_at, revoked_at
                         FROM invitation_find_by_token_hash(${this.hash(input.token)})`.execute(trx),
    );
    const inv = found.rows[0];
    if (
      !inv ||
      inv.acceptedAt ||
      inv.revokedAt ||
      inv.expiresAt.getTime() <= Date.now() ||
      inv.email !== normalizeEmail(user.email)
    ) {
      throw new AppError('INVITATION_INVALID');
    }

    return this.dbs.run({ userId: user.userId, orgId: inv.organizationId }, async (trx) => {
      const claimed = await trx
        .updateTable('invitations')
        .set({ acceptedAt: new Date(), acceptedById: user.userId })
        .where('id', '=', inv.id)
        .where('acceptedAt', 'is', null)
        .where('revokedAt', 'is', null)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) !== 1) throw new AppError('INVITATION_INVALID');

      const current = await trx
        .selectFrom('organizationMembers')
        .select(['role', 'deletedAt'])
        .where('organizationId', '=', inv.organizationId)
        .where('userId', '=', user.userId)
        .executeTakeFirst();

      if (!current) {
        await trx
          .insertInto('organizationMembers')
          .values({ organizationId: inv.organizationId, userId: user.userId, role: inv.role })
          .execute();
      } else if (current.deletedAt) {
        await trx
          .updateTable('organizationMembers')
          .set({ role: inv.role, deletedAt: null, updatedAt: new Date() })
          .where('organizationId', '=', inv.organizationId)
          .where('userId', '=', user.userId)
          .execute();
      } // already an active member: keep their existing role (never downgrade/upgrade via invite)

      for (const workspaceId of inv.workspaceIds) {
        await trx
          .insertInto('workspaceMembers')
          .values({ organizationId: inv.organizationId, workspaceId, userId: user.userId, role: inv.role })
          .onConflict((oc) => oc.columns(['workspaceId', 'userId']).doUpdateSet({ deletedAt: null, updatedAt: new Date() }))
          .execute();
      }

      await this.audit.record(trx, {
        actorType: 'USER',
        actorId: user.userId,
        orgId: inv.organizationId,
        action: 'invitation.accepted',
        targetType: 'invitation',
        targetId: inv.id,
        metadata: { role: inv.role },
        requestId: user.requestId,
        ip: user.ip,
      });
      await this.outbox.enqueue(
        trx,
        'member.joined.v1',
        { organizationId: inv.organizationId, userId: user.userId, role: inv.role },
        { orgId: inv.organizationId },
      );
      return { organizationId: inv.organizationId, role: current && !current.deletedAt ? current.role : inv.role };
    });
  }
}
