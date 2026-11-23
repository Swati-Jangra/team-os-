import { Inject, Injectable } from '@nestjs/common';
import type { ActorType, Tx } from '@teamos/database';
import { buildPageMeta, normalizePage, toSkipTake, type PageMeta } from '@teamos/shared';
import { DbService } from '../../db/db.service';
import type { RequestActor } from '../../common/actor';

export interface AuditEntry {
  actorType?: ActorType;
  actorId?: string | null;
  orgId?: string | null;
  workspaceId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ip?: string | null;
  approvalId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  /** Append an audit row inside the caller's transaction (so it commits/rolls back with the change). */
  async record(trx: Tx, e: AuditEntry): Promise<void> {
    await trx
      .insertInto('auditLogs')
      .values({
        organizationId: e.orgId ?? null,
        workspaceId: e.workspaceId ?? null,
        actorType: e.actorType ?? 'USER',
        actorId: e.actorId ?? null,
        action: e.action,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        metadata: JSON.stringify(e.metadata ?? {}),
        requestId: e.requestId ?? null,
        approvalId: e.approvalId ?? null,
        ip: e.ip ?? null,
      })
      .execute();
  }

  /** Convenience for the common case of a human acting inside an org. */
  forActor(actor: RequestActor, e: Omit<AuditEntry, 'actorType' | 'actorId' | 'orgId' | 'requestId' | 'ip'>): AuditEntry {
    return {
      ...e,
      actorType: 'USER',
      actorId: actor.userId,
      orgId: actor.orgId,
      requestId: actor.requestId,
      ip: actor.ip,
    };
  }

  async list(
    actor: RequestActor,
    q: { page?: number; pageSize?: number; action?: string; actorId?: string },
  ): Promise<{
    items: Array<{
      id: string;
      actorType: ActorType;
      actorId: string | null;
      action: string;
      targetType: string | null;
      targetId: string | null;
      metadata: Record<string, unknown>;
      requestId: string | null;
      createdAt: Date;
    }>;
    meta: PageMeta;
  }> {
    const params = normalizePage(q);
    return this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, async (trx) => {
      let base = trx.selectFrom('auditLogs').where('organizationId', '=', actor.orgId);
      if (q.action) base = base.where('action', '=', q.action);
      if (q.actorId) base = base.where('actorId', '=', q.actorId);
      const total = Number(
        (await base.select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow()).c,
      );
      const items = await base
        .select([
          'id',
          'actorType',
          'actorId',
          'action',
          'targetType',
          'targetId',
          'metadata',
          'requestId',
          'createdAt',
        ])
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(toSkipTake(params).take)
        .offset(toSkipTake(params).skip)
        .execute();
      return { items, meta: buildPageMeta(params, total) };
    });
  }
}
