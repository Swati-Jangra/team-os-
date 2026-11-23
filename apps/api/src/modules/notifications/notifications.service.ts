import { Inject, Injectable } from '@nestjs/common';
import type { NotificationCategory } from '@teamos/database';
import { AppError, buildPageMeta, normalizePage, toSkipTake, type PageMeta } from '@teamos/shared';
import {
  NOTIFICATION_CATEGORIES,
  effectivePreference,
  type NotificationCategoryName,
  type UpdateNotificationPreferencesInput,
} from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import { DbService } from '../../db/db.service';

export interface NotificationDto {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}

const COLS = ['id', 'category', 'title', 'body', 'link', 'readAt', 'createdAt'] as const;

@Injectable()
export class NotificationsService {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  private ctx(a: RequestActor) {
    return { userId: a.userId, orgId: a.orgId };
  }

  /** RLS already limits this to the caller's own notifications in this org; the filters are just filters. */
  async list(actor: RequestActor, q: { page?: number; pageSize?: number; unread?: boolean }): Promise<{ items: NotificationDto[]; meta: PageMeta }> {
    const params = normalizePage(q);
    return this.dbs.run(this.ctx(actor), async (trx) => {
      let base = trx.selectFrom('notifications');
      if (q.unread) base = base.where('readAt', 'is', null);
      const total = Number((await base.select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
      const { skip, take } = toSkipTake(params);
      const items = await base.select(COLS).orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(take).offset(skip).execute();
      return { items, meta: buildPageMeta(params, total) };
    });
  }

  async unreadCount(actor: RequestActor): Promise<{ count: number }> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const r = await trx.selectFrom('notifications').select((eb) => eb.fn.countAll().as('c')).where('readAt', 'is', null).executeTakeFirstOrThrow();
      return { count: Number(r.c) };
    });
  }

  async markRead(actor: RequestActor, id: string): Promise<NotificationDto> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const row = await trx
        .updateTable('notifications')
        .set((eb) => ({ readAt: eb.fn.coalesce('readAt', eb.val(new Date())) }))
        .where('id', '=', id)
        .returning(COLS)
        .executeTakeFirst();
      if (!row) throw new AppError('NOT_FOUND'); // also the answer for someone else's notification
      return row;
    });
  }

  async markAllRead(actor: RequestActor): Promise<{ updated: number }> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const r = await trx.updateTable('notifications').set({ readAt: new Date() }).where('readAt', 'is', null).executeTakeFirst();
      return { updated: Number(r.numUpdatedRows) };
    });
  }

  async getPreferences(user: UserActor) {
    return this.dbs.run({ userId: user.userId }, async (trx) => {
      const stored = await trx.selectFrom('notificationPreferences').select(['category', 'inApp', 'email']).execute();
      return NOTIFICATION_CATEGORIES.map((c: NotificationCategoryName) => ({ category: c, ...effectivePreference(c, stored) }));
    });
  }

  async updatePreferences(user: UserActor, input: UpdateNotificationPreferencesInput) {
    await this.dbs.run({ userId: user.userId }, async (trx) => {
      for (const p of input.preferences) {
        await trx
          .insertInto('notificationPreferences')
          .values({ userId: user.userId, category: p.category, inApp: p.inApp, email: p.email })
          .onConflict((oc) => oc.columns(['userId', 'category']).doUpdateSet({ inApp: p.inApp, email: p.email, updatedAt: new Date() }))
          .execute();
      }
    });
    return this.getPreferences(user);
  }
}
