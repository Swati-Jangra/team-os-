import { Inject, Injectable } from '@nestjs/common';
import type { MemberRole, Tx } from '@teamos/database';
import { canAssignRole, canRemoveMember, type RoleName } from '@teamos/permissions';
import { AppError } from '@teamos/shared';
import type { RequestActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';

@Injectable()
export class MembersService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async list(actor: RequestActor) {
    return this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, (trx) =>
      trx
        .selectFrom('organizationMembers as m')
        .innerJoin('users as u', 'u.id', 'm.userId')
        .select(['m.userId', 'u.name', 'u.email', 'm.role', 'm.createdAt'])
        .where('m.organizationId', '=', actor.orgId)
        .where('m.deletedAt', 'is', null)
        .orderBy('u.name')
        .execute(),
    );
  }

  /** Locks the org's OWNER rows so two concurrent demotions/removals can't both pass the check. */
  private async lockedOwnerCount(trx: Tx, orgId: string): Promise<number> {
    const owners = await trx
      .selectFrom('organizationMembers')
      .select('userId')
      .where('organizationId', '=', orgId)
      .where('role', '=', 'OWNER')
      .where('deletedAt', 'is', null)
      .forUpdate()
      .execute();
    return owners.length;
  }

  async updateRole(actor: RequestActor, targetUserId: string, newRole: MemberRole) {
    return this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, async (trx) => {
      const ownerCount = await this.lockedOwnerCount(trx, actor.orgId);
      const target = await trx
        .selectFrom('organizationMembers')
        .select('role')
        .where('organizationId', '=', actor.orgId)
        .where('userId', '=', targetUserId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw new AppError('NOT_FOUND');
      if (target.role === newRole) return { userId: targetUserId, role: newRole };

      if (!canAssignRole(actor.role, target.role as RoleName, newRole as RoleName)) throw new AppError('FORBIDDEN');
      if (target.role === 'OWNER' && newRole !== 'OWNER' && ownerCount <= 1) throw new AppError('LAST_OWNER');

      await trx
        .updateTable('organizationMembers')
        .set({ role: newRole, updatedAt: new Date() })
        .where('organizationId', '=', actor.orgId)
        .where('userId', '=', targetUserId)
        .execute();

      await this.audit.record(
        trx,
        this.audit.forActor(actor, {
          action: 'member.role_changed',
          targetType: 'user',
          targetId: targetUserId,
          metadata: { from: target.role, to: newRole },
        }),
      );
      await this.outbox.enqueue(
        trx,
        'member.role_changed.v1',
        {
          organizationId: actor.orgId,
          userId: targetUserId,
          previousRole: target.role,
          newRole,
          changedByUserId: actor.userId,
        },
        { orgId: actor.orgId },
      );
      return { userId: targetUserId, role: newRole };
    });
  }

  async remove(actor: RequestActor, targetUserId: string): Promise<void> {
    await this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, async (trx) => {
      const ownerCount = await this.lockedOwnerCount(trx, actor.orgId);
      const target = await trx
        .selectFrom('organizationMembers')
        .select('role')
        .where('organizationId', '=', actor.orgId)
        .where('userId', '=', targetUserId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw new AppError('NOT_FOUND');

      if (!canRemoveMember(actor.role, target.role as RoleName)) throw new AppError('FORBIDDEN');
      if (target.role === 'OWNER' && ownerCount <= 1) throw new AppError('LAST_OWNER');

      const now = new Date();
      await trx
        .updateTable('organizationMembers')
        .set({ deletedAt: now, updatedAt: now })
        .where('organizationId', '=', actor.orgId)
        .where('userId', '=', targetUserId)
        .execute();
      await trx
        .updateTable('workspaceMembers')
        .set({ deletedAt: now, updatedAt: now })
        .where('organizationId', '=', actor.orgId)
        .where('userId', '=', targetUserId)
        .where('deletedAt', 'is', null)
        .execute();
      await trx
        .deleteFrom('teamMembers')
        .where('organizationId', '=', actor.orgId)
        .where('userId', '=', targetUserId)
        .execute();

      await this.audit.record(
        trx,
        this.audit.forActor(actor, {
          action: 'member.removed',
          targetType: 'user',
          targetId: targetUserId,
          metadata: { role: target.role },
        }),
      );
      await this.outbox.enqueue(
        trx,
        'member.removed.v1',
        { organizationId: actor.orgId, userId: targetUserId, removedByUserId: actor.userId },
        { orgId: actor.orgId },
      );
    });
  }
}
