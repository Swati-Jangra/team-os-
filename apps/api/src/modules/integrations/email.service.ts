import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@teamos/database';
import { AppError, buildPageMeta, normalizePage, toSkipTake } from '@teamos/shared';
import type { ApproveMeetingItemInput, UpdateMeetingItemInput } from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { TasksService } from '../projects/tasks.service';

const ITEM_COLS = ['id', 'kind', 'text', 'assigneeHint', 'dueDate', 'priority', 'status', 'taskId', 'decidedBy', 'decidedAt'] as const;

/** Ingested email (read-only copy of what the worker stored) and the human decisions about its AI-proposed items. */
@Injectable()
export class EmailService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}
  private ctx = (a: RequestActor) => ({ userId: a.userId, orgId: a.orgId });

  async list(a: RequestActor, q: { page?: number; pageSize?: number; workspaceId?: string; status?: 'RECEIVED' | 'EXTRACTED' | 'FAILED'; linked?: 'true' | 'false' }) {
    const params = normalizePage(q);
    return this.dbs.run(this.ctx(a), async (trx) => {
      let base = trx.selectFrom('emailMessages as m');
      if (q.workspaceId) base = base.where('m.workspaceId', '=', q.workspaceId);
      if (q.status) base = base.where('m.status', '=', q.status);
      if (q.linked === 'true') base = base.where('m.projectId', 'is not', null);
      if (q.linked === 'false') base = base.where('m.projectId', 'is', null);
      const total = Number((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
      const { skip, take } = toSkipTake(params);
      const rows = await base.leftJoin('projects as p', 'p.id', 'm.projectId')
        .select(['m.id', 'm.workspaceId', 'm.subject', 'm.fromAddress', 'm.receivedAt', 'm.status', 'm.summary', 'm.projectId', 'm.linkSource', 'p.key as projectKey', 'p.name as projectName',
          (eb) => eb.selectFrom('emailItems as i').select((e2) => e2.fn.countAll().as('n')).whereRef('i.messageId', '=', 'm.id').where('i.status', '=', 'PENDING').as('pendingItems')])
        .orderBy('m.receivedAt', 'desc').orderBy('m.id').limit(take).offset(skip).execute();
      return { items: rows.map((r) => ({ ...r, pendingItems: Number(r.pendingItems ?? 0) })), meta: buildPageMeta(params, total) };
    });
  }

  async get(a: RequestActor, id: string) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const m = await trx.selectFrom('emailMessages as m').leftJoin('projects as p', 'p.id', 'm.projectId')
        .select(['m.id', 'm.workspaceId', 'm.subject', 'm.fromAddress', 'm.receivedAt', 'm.excerpt', 'm.status', 'm.summary', 'm.failureReason', 'm.projectId', 'm.linkSource', 'p.key as projectKey', 'p.name as projectName'])
        .where('m.id', '=', id).executeTakeFirst();
      if (!m) throw new AppError('NOT_FOUND');
      const items = await trx.selectFrom('emailItems').select(ITEM_COLS).where('messageId', '=', id).orderBy('createdAt').orderBy('id').execute();
      return { ...m, items };
    });
  }

  /** Link (or unlink with null) an email to a project of the SAME workspace. */
  async linkProject(a: RequestActor, id: string, projectId: string | null) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const m = await trx.selectFrom('emailMessages').select('workspaceId').where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw new AppError('NOT_FOUND');
      if (projectId) {
        const p = await trx.selectFrom('projects').select('id').where('id', '=', projectId).where('workspaceId', '=', m.workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
        if (!p) throw new AppError('VALIDATION_FAILED', 'Project not found in this workspace');
      }
      await trx.updateTable('emailMessages').set({ projectId, linkSource: projectId ? 'MANUAL' : null }).where('id', '=', id).execute();
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: m.workspaceId, action: projectId ? 'email.linked' : 'email.unlinked', targetType: 'email_message', targetId: id, metadata: { projectId } }));
      return { projectId };
    });
  }

  async updateItem(a: RequestActor, messageId: string, itemId: string, input: UpdateMeetingItemInput) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const it = await trx.selectFrom('emailItems').select('status').where('id', '=', itemId).where('messageId', '=', messageId).executeTakeFirst();
      if (!it) throw new AppError('NOT_FOUND');
      if (it.status !== 'PENDING') throw new AppError('CONFLICT', 'This item has already been decided.');
      const patch: Record<string, unknown> = {};
      for (const k of ['text', 'dueDate', 'priority'] as const) if (input[k] !== undefined) patch[k] = input[k];
      return trx.updateTable('emailItems').set(patch).where('id', '=', itemId).returning(ITEM_COLS).executeTakeFirstOrThrow();
    });
  }

  async reject(a: RequestActor, messageId: string, itemId: string) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const row = await this.decide(trx, a, messageId, itemId, 'REJECTED', null);
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: row.workspaceId, action: 'email.item_rejected', targetType: 'email_item', targetId: itemId, metadata: { messageId, kind: row.item.kind } }));
      return { item: row.item, taskId: null };
    });
  }

  /** Approval is the only way an email becomes work: the task is created in the same transaction that marks the item APPROVED. */
  async approve(a: RequestActor, messageId: string, itemId: string, input: ApproveMeetingItemInput) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const cur = await trx.selectFrom('emailItems as i').innerJoin('emailMessages as m', 'm.id', 'i.messageId')
        .select(['i.kind', 'i.text', 'i.dueDate', 'i.priority', 'i.status', 'i.workspaceId', 'm.projectId'])
        .where('i.id', '=', itemId).where('i.messageId', '=', messageId).forUpdate('i').executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND');
      if (cur.status !== 'PENDING') throw new AppError('CONFLICT', 'This item has already been decided.');
      let taskId: string | null = null;
      if (cur.kind === 'ACTION_ITEM') {
        const projectId = input.projectId ?? cur.projectId;
        if (!projectId) throw new AppError('VALIDATION_FAILED', 'Choose a project for the new task.');
        const proj = await trx.selectFrom('projects').select('workspaceId').where('id', '=', projectId).where('deletedAt', 'is', null).executeTakeFirst();
        if (!proj || proj.workspaceId !== cur.workspaceId) throw new AppError('VALIDATION_FAILED', 'Project must be in the same workspace as the email.');
        const task = await this.tasks.createInTx(trx, a, projectId, {
          title: input.text ?? cur.text,
          description: 'Created from an email action item (approved by a team member).',
          assigneeId: input.assigneeId ?? null,
          dueDate: input.dueDate !== undefined ? input.dueDate : cur.dueDate,
          priority: input.priority ?? cur.priority ?? undefined,
        });
        taskId = task.id;
      }
      const row = await this.decide(trx, a, messageId, itemId, 'APPROVED', taskId, input.text);
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: row.workspaceId, action: 'email.item_approved', targetType: 'email_item', targetId: itemId, metadata: { messageId, kind: row.item.kind, taskId } }));
      return { item: row.item, taskId };
    });
  }

  private async decide(trx: Tx, a: RequestActor, messageId: string, itemId: string, status: 'APPROVED' | 'REJECTED', taskId: string | null, text?: string) {
    // the status = 'PENDING' guard makes concurrent decisions race-safe: exactly one wins
    const item = await trx.updateTable('emailItems')
      .set({ status, taskId, decidedBy: a.userId, decidedAt: new Date(), ...(text ? { text: text.slice(0, 500) } : {}) })
      .where('id', '=', itemId).where('messageId', '=', messageId).where('status', '=', 'PENDING')
      .returning([...ITEM_COLS, 'workspaceId']).executeTakeFirst();
    if (!item) throw new AppError('CONFLICT', 'This item has already been decided.');
    const { workspaceId, ...rest } = item;
    return { workspaceId, item: rest };
  }
}
