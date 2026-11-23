import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type ProjectStatus, type Tx } from '@teamos/database';
import { AppError } from '@teamos/shared';
import type { CreateProjectInput, UpdateProjectInput } from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { ActivityService } from './activity.service';

export interface ProjectDto {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  ownerId: string | null;
  startDate: string | null;
  dueDate: string | null;
  createdAt: Date;
  taskCount: number;
  doneCount: number;
}

const isUnique = (e: unknown) => (e as { code?: string })?.code === '23505';

/** "Platform Engineering" -> "PE"; "Website" -> "WEB". */
export function deriveKey(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3);
  key = key.replace(/^[0-9]+/, '').slice(0, 6);
  if (key.length < 2) key = (key + 'PRJ').slice(0, 3);
  return key;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  private ctx(a: RequestActor, workspaceId?: string) {
    return { userId: a.userId, orgId: a.orgId, workspaceId };
  }

  private withCounts(trx: Tx) {
    // one pass over the project's tasks for both counters (was two correlated subqueries = two passes)
    return trx
      .selectFrom('projects as p')
      .leftJoinLateral(
        sql<{ taskCount: number; doneCount: number }>`(SELECT count(*) FILTER (WHERE t.status <> 'CANCELLED') AS task_count,
                                                        count(*) FILTER (WHERE t.status = 'DONE') AS done_count
                                                 FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL)`.as('c'),
        (join) => join.onTrue(),
      )
      .select([
        'p.id', 'p.workspaceId', 'p.key', 'p.name', 'p.description', 'p.status', 'p.ownerId', 'p.startDate', 'p.dueDate', 'p.createdAt',
        sql<number>`c.task_count`.as('taskCount'),
        sql<number>`c.done_count`.as('doneCount'),
      ])
      .where('p.deletedAt', 'is', null);
  }

  async create(actor: RequestActor, input: CreateProjectInput): Promise<ProjectDto> {
    const id = randomUUID();
    const explicitKey = input.key !== undefined;
    const base = input.key ?? deriveKey(input.name);

    for (let attempt = 0; attempt < 6; attempt++) {
      const key = attempt === 0 ? base : `${base.slice(0, 8)}${attempt + 1}`;
      try {
        return await this.dbs.run(this.ctx(actor, input.workspaceId), async (trx) => {
          const ws = await trx.selectFrom('workspaces').select('id').where('id', '=', input.workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
          if (!ws) throw new AppError('NOT_FOUND', 'Workspace not found');
          await this.assertOrgMember(trx, actor.orgId, input.ownerId);
          await trx
            .insertInto('projects')
            .values({
              id,
              organizationId: actor.orgId,
              workspaceId: input.workspaceId,
              key,
              name: input.name,
              description: input.description ?? null,
              status: input.status ?? 'PLANNING',
              ownerId: input.ownerId ?? actor.userId,
              startDate: input.startDate ?? null,
              dueDate: input.dueDate ?? null,
              createdBy: actor.userId,
            })
            .execute();
          await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: input.workspaceId, action: 'project.created', targetType: 'project', targetId: id, metadata: { key, name: input.name } }));
          await this.activity.record(trx, actor, { workspaceId: input.workspaceId, projectId: id, action: 'project.created', metadata: { name: input.name } });
          await this.outbox.enqueue(
            trx,
            'project.created.v1',
            { organizationId: actor.orgId, workspaceId: input.workspaceId, projectId: id, name: input.name, createdByUserId: actor.userId },
            { orgId: actor.orgId, workspaceId: input.workspaceId },
          );
          return this.getInTx(trx, id);
        });
      } catch (e) {
        if (!isUnique(e)) throw e;
        if (explicitKey) throw new AppError('CONFLICT', 'A project with this key already exists in the workspace');
      }
    }
    throw new AppError('CONFLICT', 'Could not generate a unique project key; provide one explicitly');
  }

  private async assertOrgMember(trx: Tx, orgId: string, userId?: string | null) {
    if (!userId) return;
    const m = await trx.selectFrom('organizationMembers').select('userId').where('organizationId', '=', orgId).where('userId', '=', userId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!m) throw new AppError('VALIDATION_FAILED', 'Owner must be a member of the organization');
  }

  private async getInTx(trx: Tx, id: string): Promise<ProjectDto> {
    const p = await this.withCounts(trx).where('p.id', '=', id).executeTakeFirst();
    if (!p) throw new AppError('NOT_FOUND');
    return p;
  }

  list(actor: RequestActor, q: { workspaceId?: string; status?: ProjectStatus }): Promise<ProjectDto[]> {
    return this.dbs.run(this.ctx(actor), (trx) => {
      let query = this.withCounts(trx);
      if (q.workspaceId) query = query.where('p.workspaceId', '=', q.workspaceId);
      if (q.status) query = query.where('p.status', '=', q.status);
      return query.orderBy('p.name').execute();
    });
  }

  get(actor: RequestActor, id: string): Promise<ProjectDto> {
    return this.dbs.run(this.ctx(actor), (trx) => this.getInTx(trx, id));
  }

  update(actor: RequestActor, id: string, input: UpdateProjectInput): Promise<ProjectDto> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const cur = await trx.selectFrom('projects').select(['workspaceId', 'startDate', 'dueDate']).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND');
      // the DB CHECK would catch this, but a partial update can cross-check against the stored dates
      const start = input.startDate !== undefined ? input.startDate : cur.startDate;
      const due = input.dueDate !== undefined ? input.dueDate : cur.dueDate;
      if (start && due && due < start) throw new AppError('VALIDATION_FAILED', 'Due date must be on or after the start date');
      await this.assertOrgMember(trx, actor.orgId, input.ownerId);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of ['name', 'description', 'status', 'ownerId', 'startDate', 'dueDate'] as const) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      await trx.updateTable('projects').set(patch).where('id', '=', id).execute();
      await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: cur.workspaceId, action: 'project.updated', targetType: 'project', targetId: id, metadata: { fields: Object.keys(input) } }));
      await this.activity.record(trx, actor, { workspaceId: cur.workspaceId, projectId: id, action: 'project.updated', metadata: { fields: Object.keys(input) } });
      await this.outbox.enqueue(trx, 'project.updated.v1', { organizationId: actor.orgId, workspaceId: cur.workspaceId, projectId: id, changedByUserId: actor.userId }, { orgId: actor.orgId, workspaceId: cur.workspaceId });
      return this.getInTx(trx, id);
    });
  }

  remove(actor: RequestActor, id: string): Promise<void> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const cur = await trx.selectFrom('projects').select('workspaceId').where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND');
      const now = new Date();
      await trx.updateTable('projects').set({ deletedAt: now, updatedAt: now }).where('id', '=', id).execute();
      await trx.updateTable('tasks').set({ deletedAt: now, updatedAt: now }).where('projectId', '=', id).where('deletedAt', 'is', null).execute();
      await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: cur.workspaceId, action: 'project.deleted', targetType: 'project', targetId: id }));
      await this.outbox.enqueue(trx, 'project.deleted.v1', { organizationId: actor.orgId, workspaceId: cur.workspaceId, projectId: id, deletedByUserId: actor.userId }, { orgId: actor.orgId, workspaceId: cur.workspaceId });
    });
  }
}
