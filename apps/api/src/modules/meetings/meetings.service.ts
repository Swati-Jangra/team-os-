import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { MeetingItemKind, MeetingItemStatus, MeetingStatus, Tx } from '@teamos/database';
import { AppError, buildPageMeta, normalizePage, toSkipTake, type PageMeta } from '@teamos/shared';
import type { ApproveMeetingItemInput, CreateMeetingInput, UpdateMeetingInput, UpdateMeetingItemInput } from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import type { AppConfig } from '../../common/app-config';
import { APP_CONFIG } from '../../common/tokens';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { TasksService } from '../projects/tasks.service';

export interface MeetingSummary {
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  heldAt: Date | null;
  status: MeetingStatus;
  hasAudio: boolean;
  hasTranscript: boolean;
  summary: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface MeetingItemDto {
  id: string;
  kind: MeetingItemKind;
  text: string;
  assigneeHint: string | null;
  dueDate: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' | null;
  status: MeetingItemStatus;
  taskId: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
}
export interface MeetingDto extends MeetingSummary {
  transcript: string | null;
  transcriptSource: 'PASTED' | 'AUDIO' | null;
  items: MeetingItemDto[];
}

export const AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
};

const ITEM_COLS = ['id', 'kind', 'text', 'assigneeHint', 'dueDate', 'priority', 'status', 'taskId', 'decidedBy', 'decidedAt'] as const;

@Injectable()
export class MeetingsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private ctx(a: RequestActor) {
    return { userId: a.userId, orgId: a.orgId };
  }

  private summarySelect(trx: Tx) {
    return trx.selectFrom('meetings').select([
      'id', 'workspaceId', 'projectId', 'title', 'heldAt', 'status', 'summary', 'failureReason', 'createdAt', 'updatedAt',
      (eb) => eb('audioPath', 'is not', null).as('hasAudio'),
      (eb) => eb('transcript', 'is not', null).as('hasTranscript'),
    ]).where('deletedAt', 'is', null);
  }

  private async assertProject(trx: Tx, workspaceId: string, projectId: string | null | undefined) {
    if (!projectId) return;
    const p = await trx.selectFrom('projects').select('id').where('id', '=', projectId).where('workspaceId', '=', workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!p) throw new AppError('VALIDATION_FAILED', 'Project not found in this workspace');
  }

  private touch(trx: Tx, a: RequestActor, type: 'meeting.created.v1' | 'meeting.updated.v1' | 'meeting.deleted.v1' | 'meeting.processing_requested.v1', workspaceId: string, meetingId: string) {
    return this.outbox.enqueue(trx, type, { organizationId: a.orgId, workspaceId, meetingId, actorUserId: a.userId }, { orgId: a.orgId, workspaceId });
  }

  async list(a: RequestActor, q: { page?: number; pageSize?: number; workspaceId?: string; projectId?: string }): Promise<{ items: MeetingSummary[]; meta: PageMeta }> {
    const params = normalizePage(q);
    return this.dbs.run(this.ctx(a), async (trx) => {
      let base = trx.selectFrom('meetings').where('deletedAt', 'is', null);
      if (q.workspaceId) base = base.where('workspaceId', '=', q.workspaceId);
      if (q.projectId) base = base.where('projectId', '=', q.projectId);
      const total = Number((await base.select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
      const { skip, take } = toSkipTake(params);
      let rows = this.summarySelect(trx);
      if (q.workspaceId) rows = rows.where('workspaceId', '=', q.workspaceId);
      if (q.projectId) rows = rows.where('projectId', '=', q.projectId);
      const items = await rows.orderBy('createdAt', 'desc').orderBy('id').limit(take).offset(skip).execute();
      return { items: items as MeetingSummary[], meta: buildPageMeta(params, total) };
    });
  }

  get(a: RequestActor, id: string): Promise<MeetingDto> {
    return this.dbs.run(this.ctx(a), async (trx) => this.load(trx, id));
  }

  private async load(trx: Tx, id: string): Promise<MeetingDto> {
    const m = await this.summarySelect(trx).select(['transcript', 'transcriptSource']).where('id', '=', id).executeTakeFirst();
    if (!m) throw new AppError('NOT_FOUND');
    const items = await trx.selectFrom('meetingItems').select(ITEM_COLS).where('meetingId', '=', id).orderBy('createdAt').orderBy('id').execute();
    return { ...(m as MeetingSummary), transcript: m.transcript, transcriptSource: m.transcriptSource, items };
  }

  create(a: RequestActor, input: CreateMeetingInput): Promise<MeetingDto> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const ws = await trx.selectFrom('workspaces').select('id').where('id', '=', input.workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!ws) throw new AppError('NOT_FOUND', 'Workspace not found');
      await this.assertProject(trx, input.workspaceId, input.projectId);
      const row = await trx.insertInto('meetings').values({
        organizationId: a.orgId, workspaceId: input.workspaceId, projectId: input.projectId ?? null, title: input.title,
        heldAt: input.heldAt ? new Date(input.heldAt) : null, transcript: input.transcript?.trim() || null,
        transcriptSource: input.transcript?.trim() ? 'PASTED' : null, createdBy: a.userId,
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: input.workspaceId, action: 'meeting.created', targetType: 'meeting', targetId: row.id, metadata: { title: input.title } }));
      await this.touch(trx, a, 'meeting.created.v1', input.workspaceId, row.id);
      return this.load(trx, row.id);
    });
  }

  update(a: RequestActor, id: string, input: UpdateMeetingInput): Promise<MeetingDto> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const cur = await trx.selectFrom('meetings').select(['workspaceId', 'status']).where('id', '=', id).where('deletedAt', 'is', null).forUpdate().executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND');
      if (cur.status === 'PROCESSING') throw new AppError('CONFLICT', 'This meeting is being processed. Try again in a moment.');
      if (input.projectId !== undefined) await this.assertProject(trx, cur.workspaceId, input.projectId);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.title !== undefined) patch.title = input.title;
      if (input.projectId !== undefined) patch.projectId = input.projectId;
      if (input.heldAt !== undefined) patch.heldAt = input.heldAt ? new Date(input.heldAt) : null;
      if (input.transcript !== undefined) {
        patch.transcript = input.transcript?.trim() || null;
        patch.transcriptSource = input.transcript?.trim() ? 'PASTED' : null;
      }
      await trx.updateTable('meetings').set(patch).where('id', '=', id).execute();
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: cur.workspaceId, action: 'meeting.updated', targetType: 'meeting', targetId: id, metadata: { fields: Object.keys(input) } }));
      await this.touch(trx, a, 'meeting.updated.v1', cur.workspaceId, id);
      return this.load(trx, id);
    });
  }

  async remove(a: RequestActor, id: string): Promise<void> {
    const audioPath = await this.dbs.run(this.ctx(a), async (trx) => {
      const m = await trx.updateTable('meetings').set({ deletedAt: new Date(), updatedAt: new Date() }).where('id', '=', id).where('deletedAt', 'is', null)
        .returning(['workspaceId', 'title', 'audioPath']).executeTakeFirst();
      if (!m) throw new AppError('NOT_FOUND');
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: m.workspaceId, action: 'meeting.deleted', targetType: 'meeting', targetId: id, metadata: { title: m.title } }));
      await this.touch(trx, a, 'meeting.deleted.v1', m.workspaceId, id);
      return m.audioPath;
    });
    if (audioPath) await rm(this.audioFile(audioPath), { force: true }).catch(() => undefined); // best effort
  }

  private audioFile(rel: string): string {
    const root = path.resolve(this.config.storageDir);
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) throw new AppError('INTERNAL');
    return full;
  }

  async uploadAudio(a: RequestActor, id: string, body: unknown, mime: string): Promise<MeetingDto> {
    const ext = AUDIO_TYPES[mime.split(';')[0]!.trim().toLowerCase()];
    if (!ext) throw new AppError('VALIDATION_FAILED', 'Unsupported audio type. Use mp3, wav, m4a, webm or ogg.');
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError('VALIDATION_FAILED', 'No audio data received');
    if (body.length > this.config.maxAudioBytes) throw new AppError('VALIDATION_FAILED', 'Audio file is too large');
    const rel = `${a.orgId}/${id}.${ext}`;
    const old = await this.dbs.run(this.ctx(a), async (trx) => {
      const m = await trx.selectFrom('meetings').select(['workspaceId', 'status', 'audioPath']).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!m) throw new AppError('NOT_FOUND');
      if (m.status === 'PROCESSING') throw new AppError('CONFLICT', 'This meeting is being processed. Try again in a moment.');
      return m;
    });
    // write to a temp file then rename, so the worker never reads a half-written upload
    const full = this.audioFile(rel);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, full);
    return this.dbs.run(this.ctx(a), async (trx) => {
      await trx.updateTable('meetings').set({ audioPath: rel, audioMime: mime.split(';')[0]!.trim().toLowerCase(), audioBytes: body.length, updatedAt: new Date() }).where('id', '=', id).execute();
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: old.workspaceId, action: 'meeting.audio_uploaded', targetType: 'meeting', targetId: id, metadata: { bytes: body.length } }));
      await this.touch(trx, a, 'meeting.updated.v1', old.workspaceId, id);
      if (old.audioPath && old.audioPath !== rel) await rm(this.audioFile(old.audioPath), { force: true }).catch(() => undefined);
      return this.load(trx, id);
    });
  }

  /** Queue transcription (if needed) + extraction. The worker does the slow work; this only flips the state. */
  process(a: RequestActor, id: string): Promise<MeetingDto> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const m = await trx.selectFrom('meetings').select(['workspaceId', 'status', 'transcript', 'audioPath']).where('id', '=', id).where('deletedAt', 'is', null).forUpdate().executeTakeFirst();
      if (!m) throw new AppError('NOT_FOUND');
      if (m.status === 'PROCESSING') throw new AppError('CONFLICT', 'This meeting is already being processed.');
      if (!m.transcript && !m.audioPath) throw new AppError('VALIDATION_FAILED', 'Add a transcript or upload audio first.');
      await trx.updateTable('meetings').set({ status: 'PROCESSING', failureReason: null, updatedAt: new Date() }).where('id', '=', id).execute();
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: m.workspaceId, action: 'meeting.processing_requested', targetType: 'meeting', targetId: id }));
      await this.touch(trx, a, 'meeting.processing_requested.v1', m.workspaceId, id);
      return this.load(trx, id);
    });
  }

  // ---------- AI-proposed items: a person reviews, corrects, approves or rejects ----------

  updateItem(a: RequestActor, meetingId: string, itemId: string, input: UpdateMeetingItemInput): Promise<MeetingItemDto> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const it = await trx.selectFrom('meetingItems').select(['status', 'kind']).where('id', '=', itemId).where('meetingId', '=', meetingId).executeTakeFirst();
      if (!it) throw new AppError('NOT_FOUND');
      if (it.status !== 'PENDING') throw new AppError('CONFLICT', 'This item has already been decided.');
      const patch: Record<string, unknown> = {};
      for (const k of ['text', 'dueDate', 'priority'] as const) if (input[k] !== undefined) patch[k] = input[k];
      return trx.updateTable('meetingItems').set(patch).where('id', '=', itemId).returning(ITEM_COLS).executeTakeFirstOrThrow();
    });
  }

  reject(a: RequestActor, meetingId: string, itemId: string): Promise<{ item: MeetingItemDto; taskId: null }> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const row = await this.decide(trx, a, meetingId, itemId, 'REJECTED', null);
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: row.workspaceId, action: 'meeting.item_rejected', targetType: 'meeting_item', targetId: itemId, metadata: { meetingId, kind: row.kind } }));
      return { item: row.item, taskId: null };
    });
  }

  /**
   * Approval is the ONLY way AI output becomes real work. An approved action item creates a task in the same
   * transaction that marks the item APPROVED, so it can never be approved twice or half-applied.
   */
  approve(a: RequestActor, meetingId: string, itemId: string, input: ApproveMeetingItemInput): Promise<{ item: MeetingItemDto; taskId: string | null }> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const cur = await trx.selectFrom('meetingItems as i').innerJoin('meetings as m', 'm.id', 'i.meetingId')
        .select(['i.kind', 'i.text', 'i.dueDate', 'i.priority', 'i.status', 'i.workspaceId', 'm.deletedAt'])
        .where('i.id', '=', itemId).where('i.meetingId', '=', meetingId).forUpdate().executeTakeFirst();
      if (!cur || cur.deletedAt) throw new AppError('NOT_FOUND');
      if (cur.status !== 'PENDING') throw new AppError('CONFLICT', 'This item has already been decided.');

      let taskId: string | null = null;
      if (cur.kind === 'ACTION_ITEM') {
        if (!input.projectId) throw new AppError('VALIDATION_FAILED', 'Choose a project for the new task.');
        const proj = await trx.selectFrom('projects').select('workspaceId').where('id', '=', input.projectId).where('deletedAt', 'is', null).executeTakeFirst();
        if (!proj || proj.workspaceId !== cur.workspaceId) throw new AppError('VALIDATION_FAILED', 'Project must be in the same workspace as the meeting.');
        const task = await this.tasks.createInTx(trx, a, input.projectId, {
          title: input.text ?? cur.text,
          description: `Created from meeting action item (approved by a team member).`,
          assigneeId: input.assigneeId ?? null,
          dueDate: input.dueDate !== undefined ? input.dueDate : cur.dueDate,
          priority: input.priority ?? cur.priority ?? undefined,
        });
        taskId = task.id;
      }
      const row = await this.decide(trx, a, meetingId, itemId, 'APPROVED', taskId, input.text);
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: row.workspaceId, action: 'meeting.item_approved', targetType: 'meeting_item', targetId: itemId, metadata: { meetingId, kind: row.kind, taskId } }));
      return { item: row.item, taskId };
    });
  }

  private async decide(trx: Tx, a: RequestActor, meetingId: string, itemId: string, status: 'APPROVED' | 'REJECTED', taskId: string | null, text?: string) {
    // the status = 'PENDING' guard makes concurrent decisions race-safe: exactly one wins
    const item = await trx.updateTable('meetingItems')
      .set({ status, taskId, decidedBy: a.userId, decidedAt: new Date(), ...(text ? { text: text.slice(0, 500) } : {}) })
      .where('id', '=', itemId).where('meetingId', '=', meetingId).where('status', '=', 'PENDING')
      .returning([...ITEM_COLS, 'workspaceId']).executeTakeFirst();
    if (!item) throw new AppError('CONFLICT', 'This item has already been decided.');
    const { workspaceId, ...rest } = item;
    return { workspaceId, kind: rest.kind, item: rest as MeetingItemDto };
  }
}
