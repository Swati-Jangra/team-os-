import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  listNotificationsQuerySchema,
  updateNotificationPreferencesSchema,
  uuidSchema,
  type UpdateNotificationPreferencesInput,
} from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import { CurrentActor, CurrentUser } from '../../common/decorators';
import { Paged } from '../../common/envelope';
import { ZodPipe } from '../../common/zod.pipe';
import { NotificationsService } from './notifications.service';

/** Every member can read their own notifications; no role permission is needed (RLS scopes the rows). */
@Controller('organizations/:orgId/notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly svc: NotificationsService) {}

  @Get()
  async list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listNotificationsQuerySchema)) q: z.infer<typeof listNotificationsQuerySchema>) {
    const { items, meta } = await this.svc.list(a, q);
    return new Paged(items, meta);
  }

  @Get('unread-count')
  unread(@CurrentActor() a: RequestActor) {
    return this.svc.unreadCount(a);
  }

  /** Declared before `:id/read` so "read-all" is never parsed as an id. */
  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentActor() a: RequestActor) {
    return this.svc.markAllRead(a);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@CurrentActor() a: RequestActor, @Param('id', new ZodPipe(uuidSchema)) id: string) {
    return this.svc.markRead(a, id);
  }
}

@Controller('me/notification-preferences')
export class NotificationPreferencesController {
  constructor(@Inject(NotificationsService) private readonly svc: NotificationsService) {}

  @Get()
  get(@CurrentUser() u: UserActor) {
    return this.svc.getPreferences(u);
  }

  @Put()
  put(@CurrentUser() u: UserActor, @Body(new ZodPipe(updateNotificationPreferencesSchema)) body: UpdateNotificationPreferencesInput) {
    return this.svc.updatePreferences(u, body);
  }
}
