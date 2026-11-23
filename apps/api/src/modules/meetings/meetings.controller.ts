import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import {
  approveMeetingItemSchema, createMeetingSchema, listMeetingsQuerySchema, updateMeetingItemSchema, updateMeetingSchema, uuidSchema,
  type ApproveMeetingItemInput, type CreateMeetingInput, type UpdateMeetingInput, type UpdateMeetingItemInput,
} from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { CurrentActor, RateLimit, RequirePermission } from '../../common/decorators';
import { Paged } from '../../common/envelope';
import { ZodPipe } from '../../common/zod.pipe';
import { MeetingsService } from './meetings.service';

const id = () => new ZodPipe(uuidSchema);

@Controller('organizations/:orgId/meetings')
export class MeetingsController {
  constructor(@Inject(MeetingsService) private readonly meetings: MeetingsService) {}

  @Get()
  @RequirePermission('document:read')
  async list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listMeetingsQuerySchema)) q: z.infer<typeof listMeetingsQuerySchema>) {
    const { items, meta } = await this.meetings.list(a, q);
    return new Paged(items, meta);
  }

  @Post()
  @RequirePermission('meeting:manage')
  create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(createMeetingSchema)) body: CreateMeetingInput) {
    return this.meetings.create(a, body);
  }

  @Get(':meetingId')
  @RequirePermission('document:read')
  get(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string) {
    return this.meetings.get(a, mid);
  }

  @Patch(':meetingId')
  @RequirePermission('meeting:manage')
  update(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string, @Body(new ZodPipe(updateMeetingSchema)) body: UpdateMeetingInput) {
    return this.meetings.update(a, mid, body);
  }

  @Delete(':meetingId')
  @HttpCode(200)
  @RequirePermission('meeting:manage')
  async remove(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string) {
    await this.meetings.remove(a, mid);
    return { deleted: true };
  }

  /** Raw audio body (Content-Type: audio/*), parsed in app.ts. */
  @Put(':meetingId/audio')
  @RequirePermission('meeting:manage')
  @RateLimit({ limit: 30, windowSec: 3600 })
  uploadAudio(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string, @Req() req: Request, @Headers('content-type') type = '') {
    return this.meetings.uploadAudio(a, mid, req.body, type);
  }

  @Post(':meetingId/process')
  @HttpCode(200)
  @RequirePermission('meeting:manage')
  @RateLimit({ limit: 60, windowSec: 3600 })
  process(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string) {
    return this.meetings.process(a, mid);
  }

  @Patch(':meetingId/items/:itemId')
  @RequirePermission('approval:decide')
  updateItem(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string, @Param('itemId', id()) iid: string, @Body(new ZodPipe(updateMeetingItemSchema)) body: UpdateMeetingItemInput) {
    return this.meetings.updateItem(a, mid, iid, body);
  }

  @Post(':meetingId/items/:itemId/approve')
  @HttpCode(200)
  @RequirePermission('approval:decide')
  approve(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string, @Param('itemId', id()) iid: string, @Body(new ZodPipe(approveMeetingItemSchema)) body: ApproveMeetingItemInput) {
    return this.meetings.approve(a, mid, iid, body);
  }

  @Post(':meetingId/items/:itemId/reject')
  @HttpCode(200)
  @RequirePermission('approval:decide')
  reject(@CurrentActor() a: RequestActor, @Param('meetingId', id()) mid: string, @Param('itemId', id()) iid: string) {
    return this.meetings.reject(a, mid, iid);
  }
}
