import { Inject, Injectable } from '@nestjs/common';
import { sql, type TaskPriority, type TaskStatus, type Tx } from '@teamos/database';
import type { EventPayload } from '@teamos/event-contracts';
import { hasPermission } from '@teamos/permissions';
import { AppError, buildPageMeta } from '@teamos/shared';
import type { CreateTaskInput, UpdateTaskInput } from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { Paged } from '../../common/envelope';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { ActivityService } from './activity.service';

export interface TaskDto {
  id: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  reporterId: string;
  milestoneId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateHours: number | null;
  labels: string[];
  position: number;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Number of unfinished tasks this one depends on. */
  openBlockers: number;
  commentCount: number;
}

export interface TaskRef {
  id: string;
  identifier: string;
  title: string;
  status: TaskStatus;
}

const DONE_LIKE: TaskStatus[] = ['DONE', 'CANCELLED'];

/** Upper bound for one project-task listing. */
export const MAX_TASKS_PER_LIST = 2000;

@Injectable()
export class TasksService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  private ctx(a: RequestActor) {
    return { userId: a.userId, orgId: a.orgId };
  }

  private base(trx: Tx) {
    return trx
      .selectFrom('tasks as t')
      .innerJoin('projects as p', 'p.id', 't.projectId')
      .leftJoin('users as u', 'u.id', 't.assigneeId')
      .select([
        't.id', 't.workspaceId', 't.projectId', 'p.key as projectKey', 't.number', 't.title', 't.description',
        't.status', 't.priority', 't.assigneeId', 'u.name as assigneeName', 't.reporterId', 't.milestoneId',
        't.startDate', 't.dueDate', 't.estimateHours', 't.labels', 't.position', 't.completedAt', 't.createdAt', 't.updatedAt',
        sql<number>`(SELECT count(*) FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id
                     WHERE d.task_id = t.id AND b.deleted_at IS NULL AND b.status NOT IN ('DONE','CANCELLED'))`.as('openBlockers'),
        sql<number>`(SELECT count(*) FROM comments c WHERE c.task_id = t.id AND c.deleted_at IS NULL)`.as('commentCount'),
      ])
      .where('t.deletedAt', 'is', null);
  }

  private toDto(r: Awaited<ReturnType<TasksService['fetchOne']>>): TaskDto {
    return {
      ...r,
      identifier: `${r.projectKey}-${r.number}`,
      estimateHours: r.estimateHours === null ? null : Number(r.estimateHours),
      openBlockers: Number(r.openBlockers),
      commentCount: Number(r.commentCount),
    };
  }

  private async fetchOne(trx: Tx, id: string) {
    const r = await this.base(trx).where('t.id', '=', id).executeTakeFirst();
    if (!r) throw new AppError('NOT_FOUND');
    return r;
  }

  /** Assignee must be an org owner/admin or an active member of the task's workspace. */
  private async assertAssignable(trx: Tx, actor: RequestActor, workspaceId: string, assigneeId: string) {
    if (assigneeId !== actor.userId && !hasPermission(actor.role, 'task:assign')) {
      throw new AppError('FORBIDDEN', 'You can only assign tasks to yourself');
    }
    const ok = await trx
      .selectFrom('organizationMembers as om')
      .select('om.userId')
      .where('om.organizationId', '=', actor.orgId)
      .where('om.userId', '=', assigneeId)
      .where('om.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('om.role', 'in', ['OWNER', 'ADMIN']),
          eb.exists(
            eb.selectFrom('workspaceMembers as wm').select('wm.userId').whereRef('wm.userId', '=', 'om.userId')
              .where('wm.workspaceId', '=', workspaceId).where('wm.deletedAt', 'is', null),
          ),
        ]),
      )
      .executeTakeFirst();
    if (!ok) throw new AppError('VALIDATION_FAILED', 'Assignee must be a member of this workspace');
  }

  private async assertMilestone(trx: Tx, projectId: string, milestoneId: string) {
    const m = await trx.selectFrom('milestones').select('id').where('id', '=', milestoneId).where('projectId', '=', projectId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!m) throw new AppError('VALIDATION_FAILED', 'Milestone does not belong to this project');
  }

  /**
   * All tasks of a project (the board needs the whole set), bounded so one huge project cannot make a
   * single request unbounded. `meta.total` tells the client when the list was cut at MAX_TASKS_PER_LIST.
   */
  async list(actor: RequestActor, projectId: string, q: { status?: TaskStatus; assigneeId?: string; milestoneId?: string; q?: string }): Promise<Paged<TaskDto>> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const p = await trx.selectFrom('projects').select('id').where('id', '=', projectId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!p) throw new AppError('NOT_FOUND');
      let query = this.base(trx).where('t.projectId', '=', projectId);
      if (q.status) query = query.where('t.status', '=', q.status);
      if (q.assigneeId) query = query.where('t.assigneeId', '=', q.assigneeId);
      if (q.milestoneId) query = query.where('t.milestoneId', '=', q.milestoneId);
      if (q.q) query = query.where((eb) => eb.or([eb('t.title', 'ilike', `%${q.q!.replace(/[%_\\]/g, '\\$&')}%`)]));
      const rows = await query.orderBy('t.position').orderBy('t.number').limit(MAX_TASKS_PER_LIST + 1).execute();
      const truncated = rows.length > MAX_TASKS_PER_LIST;
      let total = rows.length;
      if (truncated) {
        let count = trx.selectFrom('tasks as t').select((eb) => eb.fn.countAll<string>().as('n')).where('t.projectId', '=', projectId).where('t.deletedAt', 'is', null);
        if (q.status) count = count.where('t.status', '=', q.status);
        if (q.assigneeId) count = count.where('t.assigneeId', '=', q.assigneeId);
        if (q.milestoneId) count = count.where('t.milestoneId', '=', q.milestoneId);
        if (q.q) count = count.where('t.title', 'ilike', `%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
        total = Number((await count.executeTakeFirstOrThrow()).n);
      }
      return new Paged(rows.slice(0, MAX_TASKS_PER_LIST).map((r) => this.toDto(r)), buildPageMeta({ page: 1, pageSize: MAX_TASKS_PER_LIST }, total));
    });
  }

  async mine(actor: RequestActor): Promise<TaskDto[]> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const rows = await this.base(trx)
        .where('t.assigneeId', '=', actor.userId)
        .where('t.status', 'not in', DONE_LIKE)
        .orderBy(sql`t.due_date NULLS LAST`)
        .orderBy('t.priority', 'desc')
        .limit(100)
        .execute();
      return rows.map((r) => this.toDto(r));
    });
  }

  async create(actor: RequestActor, projectId: string, input: CreateTaskInput): Promise<TaskDto> {
    return this.dbs.run(this.ctx(actor), (trx) => this.createInTx(trx, actor, projectId, input));
  }

  /** create() inside the caller's transaction, for flows that must commit atomically with other changes (approvals). */
  async createInTx(trx: Tx, actor: RequestActor, projectId: string, input: CreateTaskInput): Promise<TaskDto> {
    {
      // atomic per-project counter; the row lock also serializes concurrent creates
      const proj = await trx
        .updateTable('projects')
        .set({ taskSeq: sql`task_seq + 1`, updatedAt: new Date() })
        .where('id', '=', projectId)
        .where('deletedAt', 'is', null)
        .returning(['workspaceId', 'taskSeq', 'key'])
        .executeTakeFirst();
      if (!proj) throw new AppError('NOT_FOUND');
      if (input.assigneeId) await this.assertAssignable(trx, actor, proj.workspaceId, input.assigneeId);
      if (input.milestoneId) await this.assertMilestone(trx, projectId, input.milestoneId);

      const status = input.status ?? 'TODO';
      // ORDER BY position DESC LIMIT 1 walks tasks_project_order_idx backwards and stops at the first row of
      // this column. (max() is not rewritten this way under RLS, and the enum `status = x` comparison is not
      // leakproof, so under RLS it cannot be an index condition; it stays a cheap filter on the walk.)
      const last = await trx
        .selectFrom('tasks')
        .select('position')
        .where('projectId', '=', projectId)
        .where('deletedAt', 'is', null)
        .where('status', '=', status)
        .orderBy('position', 'desc')
        .limit(1)
        .executeTakeFirst();
      const maxPos = { m: last?.position ?? 0 };

      const row = await trx
        .insertInto('tasks')
        .values({
          organizationId: actor.orgId,
          workspaceId: proj.workspaceId,
          projectId,
          milestoneId: input.milestoneId ?? null,
          number: proj.taskSeq,
          title: input.title,
          description: input.description ?? null,
          status,
          priority: input.priority ?? 'MEDIUM',
          assigneeId: input.assigneeId ?? null,
          reporterId: actor.userId,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          estimateHours: input.estimateHours ?? null,
          labels: input.labels ?? [],
          position: Number(maxPos.m) + 1000,
          completedAt: status === 'DONE' ? new Date() : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const identifier = `${proj.key}-${proj.taskSeq}`;
      await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: proj.workspaceId, action: 'task.created', targetType: 'task', targetId: row.id, metadata: { identifier } }));
      await this.activity.record(trx, actor, { workspaceId: proj.workspaceId, projectId, taskId: row.id, action: 'task.created', metadata: { identifier, title: input.title } });
      const scope = { orgId: actor.orgId, workspaceId: proj.workspaceId };
      const base = { organizationId: actor.orgId, workspaceId: proj.workspaceId, projectId, taskId: row.id, title: input.title };
      await this.outbox.enqueue(trx, 'task.created.v1', { ...base, createdByUserId: actor.userId }, scope);
      if (input.assigneeId) {
        await this.activity.record(trx, actor, { workspaceId: proj.workspaceId, projectId, taskId: row.id, action: 'task.assigned', metadata: { assigneeId: input.assigneeId } });
        await this.outbox.enqueue(trx, 'task.assigned.v1', { ...base, assigneeId: input.assigneeId, previousAssigneeId: null, assignedByUserId: actor.userId }, scope);
      }
      return this.toDto(await this.fetchOne(trx, row.id));
    }
  }

  async get(actor: RequestActor, id: string): Promise<TaskDto & { blockedBy: TaskRef[]; blocks: TaskRef[] }> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const dto = this.toDto(await this.fetchOne(trx, id));
      const [blockedBy, blocks] = await Promise.all([this.refs(trx, id, 'blockedBy'), this.refs(trx, id, 'blocks')]);
      return { ...dto, blockedBy, blocks };
    });
  }

  private async refs(trx: Tx, taskId: string, dir: 'blockedBy' | 'blocks'): Promise<TaskRef[]> {
    const [from, to] = dir === 'blockedBy' ? (['taskId', 'dependsOnTaskId'] as const) : (['dependsOnTaskId', 'taskId'] as const);
    const rows = await trx
      .selectFrom('taskDependencies as d')
      .innerJoin('tasks as t', 't.id', `d.${to}`)
      .innerJoin('projects as p', 'p.id', 't.projectId')
      .select(['t.id', 'p.key', 't.number', 't.title', 't.status'])
      .where(`d.${from}`, '=', taskId)
      .where('t.deletedAt', 'is', null)
      .orderBy('t.number')
      .execute();
    return rows.map((r) => ({ id: r.id, identifier: `${r.key}-${r.number}`, title: r.title, status: r.status }));
  }

  async update(actor: RequestActor, id: string, input: UpdateTaskInput): Promise<TaskDto> {
    return this.dbs.run(this.ctx(actor), (trx) => this.updateInTx(trx, actor, id, input));
  }

  /** Same rules as `update`, inside a caller-owned transaction (used by approved agent actions). */
  async updateInTx(trx: Tx, actor: RequestActor, id: string, input: UpdateTaskInput): Promise<TaskDto> {
    {
      const cur = await trx
        .selectFrom('tasks')
        .select(['workspaceId', 'projectId', 'title', 'status', 'assigneeId', 'startDate', 'dueDate', 'milestoneId'])
        .where('id', '=', id)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND');

      const start = input.startDate !== undefined ? input.startDate : cur.startDate;
      const due = input.dueDate !== undefined ? input.dueDate : cur.dueDate;
      if (start && due && due < start) throw new AppError('VALIDATION_FAILED', 'Due date must be on or after the start date');

      const assigneeChanged = input.assigneeId !== undefined && input.assigneeId !== cur.assigneeId;
      if (assigneeChanged) {
        if (input.assigneeId) await this.assertAssignable(trx, actor, cur.workspaceId, input.assigneeId);
        else if (!hasPermission(actor.role, 'task:assign') && cur.assigneeId !== actor.userId) {
          throw new AppError('FORBIDDEN', 'You cannot unassign this task');
        }
      }
      if (input.milestoneId) await this.assertMilestone(trx, cur.projectId, input.milestoneId);

      const statusChanged = input.status !== undefined && input.status !== cur.status;
      if (statusChanged && input.status === 'DONE') {
        const open = await this.refs(trx, id, 'blockedBy');
        const unfinished = open.filter((b) => !DONE_LIKE.includes(b.status));
        if (unfinished.length > 0) {
          throw new AppError('CONFLICT', 'This task is blocked by unfinished tasks', { blockers: unfinished.map((b) => b.identifier) });
        }
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of ['title', 'description', 'status', 'priority', 'assigneeId', 'milestoneId', 'startDate', 'dueDate', 'estimateHours', 'labels', 'position'] as const) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      if (statusChanged) patch.completedAt = input.status === 'DONE' ? new Date() : null;
      await trx.updateTable('tasks').set(patch as never).where('id', '=', id).execute();

      const changed = Object.keys(input).filter((k) => k !== 'position');
      const scope = { orgId: actor.orgId, workspaceId: cur.workspaceId };
      const base = { organizationId: actor.orgId, workspaceId: cur.workspaceId, projectId: cur.projectId, taskId: id, title: input.title ?? cur.title };
      if (changed.length > 0) {
        await this.activity.record(trx, actor, { workspaceId: cur.workspaceId, projectId: cur.projectId, taskId: id, action: 'task.updated', metadata: { fields: changed } });
      }
      // every board-visible change (incl. drag reordering) emits one realtime event
      await this.outbox.enqueue(trx, 'task.updated.v1', { organizationId: actor.orgId, workspaceId: cur.workspaceId, projectId: cur.projectId, taskId: id, fields: Object.keys(input), changedByUserId: actor.userId }, scope);
      if (statusChanged) {
        await this.activity.record(trx, actor, { workspaceId: cur.workspaceId, projectId: cur.projectId, taskId: id, action: 'task.status_changed', metadata: { from: cur.status, to: input.status } });
        await this.outbox.enqueue(trx, 'task.status_changed.v1', { ...base, previousStatus: cur.status, newStatus: input.status!, changedByUserId: actor.userId } satisfies EventPayload<'task.status_changed.v1'>, scope);
      }
      if (assigneeChanged) {
        await this.activity.record(trx, actor, { workspaceId: cur.workspaceId, projectId: cur.projectId, taskId: id, action: 'task.assigned', metadata: { from: cur.assigneeId, to: input.assigneeId } });
        if (input.assigneeId) {
          await this.outbox.enqueue(trx, 'task.assigned.v1', { ...base, assigneeId: input.assigneeId, previousAssigneeId: cur.assigneeId, assignedByUserId: actor.userId }, scope);
        }
      }
      return this.toDto(await this.fetchOne(trx, id));
    }
  }

  async remove(actor: RequestActor, id: string): Promise<void> {
    await this.dbs.run(this.ctx(actor), async (trx) => {
      const cur = await trx.selectFrom('tasks').select(['workspaceId', 'projectId', 'title']).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND');
      await trx.updateTable('tasks').set({ deletedAt: new Date(), updatedAt: new Date() }).where('id', '=', id).execute();
      await trx.deleteFrom('taskDependencies').where((eb) => eb.or([eb('taskId', '=', id), eb('dependsOnTaskId', '=', id)])).execute();
      await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: cur.workspaceId, action: 'task.deleted', targetType: 'task', targetId: id, metadata: { title: cur.title } }));
      await this.activity.record(trx, actor, { workspaceId: cur.workspaceId, projectId: cur.projectId, taskId: id, action: 'task.deleted', metadata: { title: cur.title } });
      await this.outbox.enqueue(trx, 'task.deleted.v1', { organizationId: actor.orgId, workspaceId: cur.workspaceId, projectId: cur.projectId, taskId: id, deletedByUserId: actor.userId }, { orgId: actor.orgId, workspaceId: cur.workspaceId });
    });
  }

  // ---------- dependencies ----------

  async addDependency(actor: RequestActor, taskId: string, dependsOnTaskId: string): Promise<{ blockedBy: TaskRef[] }> {
    if (taskId === dependsOnTaskId) throw new AppError('VALIDATION_FAILED', 'A task cannot depend on itself');
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const tasks = await trx
        .selectFrom('tasks')
        .select(['id', 'workspaceId', 'projectId'])
        .where('id', 'in', [taskId, dependsOnTaskId])
        .where('deletedAt', 'is', null)
        .execute();
      const a = tasks.find((t) => t.id === taskId);
      const b = tasks.find((t) => t.id === dependsOnTaskId);
      if (!a || !b) throw new AppError('NOT_FOUND');
      if (a.workspaceId !== b.workspaceId) throw new AppError('VALIDATION_FAILED', 'Tasks must be in the same workspace');

      // Serialize dependency edits per workspace so two concurrent inserts cannot jointly form a cycle.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${a.workspaceId}))`.execute(trx);

      const cycle = await sql<{ found: boolean }>`
        WITH RECURSIVE chain(id) AS (
          SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ${dependsOnTaskId}
          UNION
          SELECT d.depends_on_task_id FROM task_dependencies d JOIN chain c ON d.task_id = c.id
        )
        SELECT EXISTS (SELECT 1 FROM chain WHERE id = ${taskId}) AS found`.execute(trx);
      if (cycle.rows[0]?.found) throw new AppError('CONFLICT', 'This dependency would create a cycle');

      const inserted = await trx
        .insertInto('taskDependencies')
        .values({ organizationId: actor.orgId, workspaceId: a.workspaceId, taskId, dependsOnTaskId, createdBy: actor.userId })
        .onConflict((oc) => oc.columns(['taskId', 'dependsOnTaskId']).doNothing())
        .executeTakeFirst();
      if (inserted.numInsertedOrUpdatedRows !== undefined && Number(inserted.numInsertedOrUpdatedRows) > 0) {
        await this.activity.record(trx, actor, { workspaceId: a.workspaceId, projectId: a.projectId, taskId, action: 'task.dependency_added', metadata: { dependsOnTaskId } });
        await this.outbox.enqueue(trx, 'task.dependency_changed.v1', { organizationId: actor.orgId, workspaceId: a.workspaceId, projectId: a.projectId, taskId, changedByUserId: actor.userId }, { orgId: actor.orgId, workspaceId: a.workspaceId });
      }
      return { blockedBy: await this.refs(trx, taskId, 'blockedBy') };
    });
  }

  async removeDependency(actor: RequestActor, taskId: string, dependsOnTaskId: string): Promise<void> {
    await this.dbs.run(this.ctx(actor), async (trx) => {
      const t = await trx.selectFrom('tasks').select(['workspaceId', 'projectId']).where('id', '=', taskId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!t) throw new AppError('NOT_FOUND');
      const r = await trx.deleteFrom('taskDependencies').where('taskId', '=', taskId).where('dependsOnTaskId', '=', dependsOnTaskId).executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) throw new AppError('NOT_FOUND');
      await this.activity.record(trx, actor, { workspaceId: t.workspaceId, projectId: t.projectId, taskId, action: 'task.dependency_removed', metadata: { dependsOnTaskId } });
      await this.outbox.enqueue(trx, 'task.dependency_changed.v1', { organizationId: actor.orgId, workspaceId: t.workspaceId, projectId: t.projectId, taskId, changedByUserId: actor.userId }, { orgId: actor.orgId, workspaceId: t.workspaceId });
    });
  }
}
