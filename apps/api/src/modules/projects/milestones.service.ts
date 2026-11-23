import { Inject, Injectable } from '@nestjs/common';
import type { MilestoneStatus } from '@teamos/database';
import { sql } from '@teamos/database';
import { AppError } from '@teamos/shared';
import type { CreateMilestoneInput, UpdateMilestoneInput } from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { ActivityService } from './activity.service';

export interface MilestoneDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  dueDate: string | null;
  status: MilestoneStatus;
  taskCount: number;
  doneCount: number;
}

@Injectable()
export class MilestonesService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  private changed(trx: Parameters<Parameters<DbService['run']>[1]>[0], actor: RequestActor, workspaceId: string, projectId: string) {
    return this.outbox.enqueue(trx, 'milestone.changed.v1', { organizationId: actor.orgId, workspaceId, projectId, changedByUserId: actor.userId }, { orgId: actor.orgId, workspaceId });
  }

  private ctx(a: RequestActor) {
    return { userId: a.userId, orgId: a.orgId };
  }

  private select(trx: Parameters<Parameters<DbService['run']>[1]>[0]) {
    return trx
      .selectFrom('milestones as m')
      .select([
        'm.id', 'm.projectId', 'm.name', 'm.description', 'm.dueDate', 'm.status',
        sql<number>`(SELECT count(*) FROM tasks t WHERE t.milestone_id = m.id AND t.deleted_at IS NULL AND t.status <> 'CANCELLED')`.as('taskCount'),
        sql<number>`(SELECT count(*) FROM tasks t WHERE t.milestone_id = m.id AND t.deleted_at IS NULL AND t.status = 'DONE')`.as('doneCount'),
      ])
      .where('m.deletedAt', 'is', null);
  }

  list(actor: RequestActor, projectId: string): Promise<MilestoneDto[]> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const p = await trx.selectFrom('projects').select('id').where('id', '=', projectId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!p) throw new AppError('NOT_FOUND');
      return this.select(trx).where('m.projectId', '=', projectId).orderBy(sql`m.due_date NULLS LAST`).orderBy('m.name').execute();
    });
  }

  create(actor: RequestActor, projectId: string, input: CreateMilestoneInput): Promise<MilestoneDto> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const p = await trx.selectFrom('projects').select(['id', 'workspaceId']).where('id', '=', projectId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!p) throw new AppError('NOT_FOUND');
      const row = await trx
        .insertInto('milestones')
        .values({ organizationId: actor.orgId, workspaceId: p.workspaceId, projectId, name: input.name, description: input.description ?? null, dueDate: input.dueDate ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: p.workspaceId, action: 'milestone.created', targetType: 'milestone', targetId: row.id, metadata: { projectId, name: input.name } }));
      await this.activity.record(trx, actor, { workspaceId: p.workspaceId, projectId, action: 'milestone.created', metadata: { name: input.name } });
      await this.changed(trx, actor, p.workspaceId, projectId);
      return this.select(trx).where('m.id', '=', row.id).executeTakeFirstOrThrow();
    });
  }

  update(actor: RequestActor, id: string, input: UpdateMilestoneInput): Promise<MilestoneDto> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const cur = await trx.selectFrom('milestones').select(['workspaceId', 'projectId']).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND');
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of ['name', 'description', 'dueDate', 'status'] as const) if (input[k] !== undefined) patch[k] = input[k];
      await trx.updateTable('milestones').set(patch).where('id', '=', id).execute();
      await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: cur.workspaceId, action: 'milestone.updated', targetType: 'milestone', targetId: id, metadata: { fields: Object.keys(input) } }));
      await this.activity.record(trx, actor, { workspaceId: cur.workspaceId, projectId: cur.projectId, action: 'milestone.updated', metadata: { fields: Object.keys(input), id } });
      await this.changed(trx, actor, cur.workspaceId, cur.projectId);
      return this.select(trx).where('m.id', '=', id).executeTakeFirstOrThrow();
    });
  }

  remove(actor: RequestActor, id: string): Promise<void> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const cur = await trx.selectFrom('milestones').select(['workspaceId', 'projectId', 'name']).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND');
      // detach tasks, then soft delete (a deleted milestone must not keep tasks pointing at it)
      await trx.updateTable('tasks').set({ milestoneId: null, updatedAt: new Date() }).where('milestoneId', '=', id).execute();
      await trx.updateTable('milestones').set({ deletedAt: new Date(), updatedAt: new Date() }).where('id', '=', id).execute();
      await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: cur.workspaceId, action: 'milestone.deleted', targetType: 'milestone', targetId: id }));
      await this.activity.record(trx, actor, { workspaceId: cur.workspaceId, projectId: cur.projectId, action: 'milestone.deleted', metadata: { name: cur.name } });
      await this.changed(trx, actor, cur.workspaceId, cur.projectId);
    });
  }
}
