import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@teamos/database';
import { AppError } from '@teamos/shared';
import type { RequestActor } from '../../common/actor';
import { DbService } from '../../db/db.service';

export interface ActivityDto {
  id: string;
  projectId: string;
  taskId: string | null;
  actorId: string | null;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

@Injectable()
export class ActivityService {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  /** Append to the project/task activity feed inside the caller's transaction. */
  async record(
    trx: Tx,
    actor: RequestActor,
    e: { workspaceId: string; projectId: string; taskId?: string | null; action: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await trx
      .insertInto('activityEvents')
      .values({
        organizationId: actor.orgId,
        workspaceId: e.workspaceId,
        projectId: e.projectId,
        taskId: e.taskId ?? null,
        actorType: 'USER',
        actorId: actor.userId,
        action: e.action,
        metadata: JSON.stringify(e.metadata ?? {}),
      })
      .execute();
  }

  async forProject(actor: RequestActor, projectId: string, taskId?: string, limit = 50): Promise<ActivityDto[]> {
    return this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, async (trx) => {
      const exists = await trx.selectFrom('projects').select('id').where('id', '=', projectId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!exists) throw new AppError('NOT_FOUND');
      let q = trx
        .selectFrom('activityEvents')
        .select(['id', 'projectId', 'taskId', 'actorId', 'action', 'metadata', 'createdAt'])
        .where('projectId', '=', projectId);
      if (taskId) q = q.where('taskId', '=', taskId);
      return q.orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(Math.min(limit, 100)).execute();
    });
  }
}
