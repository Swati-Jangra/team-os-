import { Inject, Injectable } from '@nestjs/common';
import { hasPermission } from '@teamos/permissions';
import { AppError } from '@teamos/shared';
import type { RequestActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { OutboxService } from '../outbox/outbox.service';
import { ActivityService } from './activity.service';

export interface CommentDto {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  editedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class CommentsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  private ctx(a: RequestActor) {
    return { userId: a.userId, orgId: a.orgId };
  }

  private select(trx: Parameters<Parameters<DbService['run']>[1]>[0]) {
    return trx
      .selectFrom('comments as c')
      .innerJoin('users as u', 'u.id', 'c.authorId')
      .select(['c.id', 'c.taskId', 'c.authorId', 'u.name as authorName', 'c.body', 'c.editedAt', 'c.createdAt'])
      .where('c.deletedAt', 'is', null);
  }

  list(actor: RequestActor, taskId: string): Promise<CommentDto[]> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const t = await trx.selectFrom('tasks').select('id').where('id', '=', taskId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!t) throw new AppError('NOT_FOUND');
      return this.select(trx).where('c.taskId', '=', taskId).orderBy('c.createdAt').orderBy('c.id').execute();
    });
  }

  create(actor: RequestActor, taskId: string, body: string): Promise<CommentDto> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const t = await trx.selectFrom('tasks').select(['workspaceId', 'projectId']).where('id', '=', taskId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!t) throw new AppError('NOT_FOUND');
      const row = await trx
        .insertInto('comments')
        .values({ organizationId: actor.orgId, workspaceId: t.workspaceId, taskId, authorId: actor.userId, body })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.activity.record(trx, actor, { workspaceId: t.workspaceId, projectId: t.projectId, taskId, action: 'comment.created', metadata: { commentId: row.id } });
      await this.outbox.enqueue(
        trx,
        'task.commented.v1',
        { organizationId: actor.orgId, workspaceId: t.workspaceId, projectId: t.projectId, taskId, commentId: row.id, authorId: actor.userId },
        { orgId: actor.orgId, workspaceId: t.workspaceId },
      );
      return this.select(trx).where('c.id', '=', row.id).executeTakeFirstOrThrow();
    });
  }

  /** Only the author may edit. */
  update(actor: RequestActor, commentId: string, body: string): Promise<CommentDto> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const c = await trx.selectFrom('comments').select('authorId').where('id', '=', commentId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!c) throw new AppError('NOT_FOUND');
      if (c.authorId !== actor.userId) throw new AppError('FORBIDDEN', 'Only the author can edit a comment');
      await trx.updateTable('comments').set({ body, editedAt: new Date() }).where('id', '=', commentId).execute();
      return this.select(trx).where('c.id', '=', commentId).executeTakeFirstOrThrow();
    });
  }

  /** Author, or anyone who can delete tasks (moderation). */
  remove(actor: RequestActor, commentId: string): Promise<void> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const c = await trx.selectFrom('comments').select(['authorId', 'workspaceId', 'taskId']).where('id', '=', commentId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!c) throw new AppError('NOT_FOUND');
      if (c.authorId !== actor.userId && !hasPermission(actor.role, 'task:delete')) throw new AppError('FORBIDDEN');
      await trx.updateTable('comments').set({ deletedAt: new Date() }).where('id', '=', commentId).execute();
    });
  }
}
