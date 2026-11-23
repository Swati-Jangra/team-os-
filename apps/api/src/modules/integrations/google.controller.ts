import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Patch, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import {
  approveMeetingItemSchema, connectCalendarSchema, connectMailboxSchema, linkEmailProjectSchema, linkMeetingEventSchema, listCalendarEventsQuerySchema, listEmailsQuerySchema,
  oauthCallbackQuerySchema, updateMeetingItemSchema, uuidSchema, type ApproveMeetingItemInput, type ConnectCalendarInput, type ConnectMailboxInput, type UpdateMeetingItemInput,
} from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import type { AppConfig } from '../../common/app-config';
import { CurrentActor, CurrentUser, RequirePermission } from '../../common/decorators';
import { Paged } from '../../common/envelope';
import { APP_CONFIG } from '../../common/tokens';
import { ZodPipe } from '../../common/zod.pipe';
import { EmailService } from './email.service';
import { GoogleService } from './google.service';

const id = () => new ZodPipe(uuidSchema);

@Controller('organizations/:orgId')
export class GoogleController {
  constructor(
    @Inject(GoogleService) private readonly google: GoogleService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  @Get('google')
  @RequirePermission('project:read')
  overview(@CurrentActor() a: RequestActor) {
    return this.google.overview(a);
  }

  @Post('google/calendar/authorize')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  authorizeCalendar(@CurrentActor() a: RequestActor) {
    return this.google.start(a, 'calendar');
  }

  @Post('google/mail/authorize')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  authorizeMail(@CurrentActor() a: RequestActor) {
    return this.google.start(a, 'mail');
  }

  @Delete('google/:integrationId')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  async disconnect(@CurrentActor() a: RequestActor, @Param('integrationId', id()) iid: string) {
    await this.google.disconnect(a, iid);
    return { disconnected: true };
  }

  // ---- calendars
  @Get('google/:integrationId/calendars')
  @RequirePermission('integration:manage')
  calendars(@CurrentActor() a: RequestActor, @Param('integrationId', id()) iid: string) {
    return this.google.availableCalendars(a, iid);
  }

  @Post('google/:integrationId/calendar-sources')
  @HttpCode(201)
  @RequirePermission('integration:manage')
  connectCalendar(@CurrentActor() a: RequestActor, @Param('integrationId', id()) iid: string, @Body(new ZodPipe(connectCalendarSchema)) body: ConnectCalendarInput) {
    return this.google.connectCalendar(a, iid, body);
  }

  @Delete('google/calendar-sources/:sourceId')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  async disconnectCalendar(@CurrentActor() a: RequestActor, @Param('sourceId', id()) sid: string) {
    await this.google.disconnectCalendar(a, sid);
    return { disconnected: true };
  }

  @Post('google/calendar-sources/:sourceId/sync')
  @HttpCode(202)
  @RequirePermission('integration:manage')
  syncCalendar(@CurrentActor() a: RequestActor, @Param('sourceId', id()) sid: string) {
    return this.google.syncCalendarNow(a, sid);
  }

  @Get('calendar/events')
  @RequirePermission('project:read')
  events(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listCalendarEventsQuerySchema)) q: z.infer<typeof listCalendarEventsQuerySchema>) {
    return this.google.events(a, q);
  }

  @Get('meetings/:meetingId/calendar-event')
  @RequirePermission('document:read')
  meetingEvent(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string) {
    return this.google.meetingEvent(a, mid);
  }

  @Post('meetings/:meetingId/calendar-event')
  @HttpCode(201)
  @RequirePermission('meeting:manage')
  linkMeeting(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string, @Body(new ZodPipe(linkMeetingEventSchema)) body: { eventId: string }) {
    return this.google.linkMeeting(a, mid, body.eventId);
  }

  @Delete('meetings/:meetingId/calendar-event')
  @HttpCode(200)
  @RequirePermission('meeting:manage')
  async unlinkMeeting(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string) {
    await this.google.unlinkMeeting(a, mid);
    return { unlinked: true };
  }

  // ---- mailbox
  @Post('google/:integrationId/mailbox')
  @HttpCode(201)
  @RequirePermission('integration:manage')
  connectMailbox(@CurrentActor() a: RequestActor, @Param('integrationId', id()) iid: string, @Body(new ZodPipe(connectMailboxSchema)) body: ConnectMailboxInput) {
    return this.google.connectMailbox(a, iid, body);
  }

  @Delete('google/mailboxes/:sourceId')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  async disconnectMailbox(@CurrentActor() a: RequestActor, @Param('sourceId', id()) sid: string) {
    await this.google.disconnectMailbox(a, sid);
    return { disconnected: true };
  }

  @Post('google/mailboxes/:sourceId/sync')
  @HttpCode(202)
  @RequirePermission('integration:manage')
  syncMailbox(@CurrentActor() a: RequestActor, @Param('sourceId', id()) sid: string) {
    return this.google.syncMailboxNow(a, sid);
  }

  // ---- ingested email
  @Get('emails')
  @RequirePermission('document:read')
  async emails(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listEmailsQuerySchema)) q: z.infer<typeof listEmailsQuerySchema>) {
    const { items, meta } = await this.email.list(a, q);
    return new Paged(items, meta);
  }

  @Get('emails/:messageId')
  @RequirePermission('document:read')
  emailDetail(@CurrentActor() a: RequestActor, @Param('messageId', id()) mid: string) {
    return this.email.get(a, mid);
  }

  @Put('emails/:messageId/project')
  @RequirePermission('task:create')
  linkEmail(@CurrentActor() a: RequestActor, @Param('messageId', id()) mid: string, @Body(new ZodPipe(linkEmailProjectSchema)) body: { projectId: string | null }) {
    return this.email.linkProject(a, mid, body.projectId);
  }

  @Patch('emails/:messageId/items/:itemId')
  @RequirePermission('approval:decide')
  updateItem(@CurrentActor() a: RequestActor, @Param('messageId', id()) mid: string, @Param('itemId', id()) iid: string, @Body(new ZodPipe(updateMeetingItemSchema)) body: UpdateMeetingItemInput) {
    return this.email.updateItem(a, mid, iid, body);
  }

  @Post('emails/:messageId/items/:itemId/approve')
  @HttpCode(200)
  @RequirePermission('approval:decide')
  approve(@CurrentActor() a: RequestActor, @Param('messageId', id()) mid: string, @Param('itemId', id()) iid: string, @Body(new ZodPipe(approveMeetingItemSchema)) body: ApproveMeetingItemInput) {
    return this.email.approve(a, mid, iid, body);
  }

  @Post('emails/:messageId/items/:itemId/reject')
  @HttpCode(200)
  @RequirePermission('approval:decide')
  reject(@CurrentActor() a: RequestActor, @Param('messageId', id()) mid: string, @Param('itemId', id()) iid: string) {
    return this.email.reject(a, mid, iid);
  }
}

@Controller()
export class GooglePublicController {
  constructor(
    @Inject(GoogleService) private readonly google: GoogleService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Browser redirect target after Google's consent screen; needs the user's session like any other request. */
  @Get('integrations/google/callback')
  async callback(@CurrentUser() user: UserActor, @Query(new ZodPipe(oauthCallbackQuerySchema)) q: z.infer<typeof oauthCallbackQuerySchema>, @Res() res: Response) {
    const r = await this.google.finish(user, q);
    const base = `${this.config.appUrl}/o/${r.orgId}/integrations`;
    res.redirect(302, r.ok ? `${base}?connected=google` : `${base}?error=${r.error ?? 'google_denied'}`);
  }
}
