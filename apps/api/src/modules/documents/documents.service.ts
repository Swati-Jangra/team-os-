import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@teamos/database';
import { AppError, buildPageMeta, normalizePage, toSkipTake, type PageMeta } from '@teamos/shared';
import type { CreateDocumentInput, UpdateDocumentInput } from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { sanitizeDocumentHtml } from './sanitize';

export interface DocumentSummary {
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface DocumentDto extends DocumentSummary {
  contentHtml: string;
}
export interface VersionSummary {
  version: number;
  title: string;
  createdBy: string;
  createdAt: Date;
}

const SUMMARY = ['id', 'workspaceId', 'projectId', 'title', 'version', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt'] as const;

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  private ctx(a: RequestActor) {
    return { userId: a.userId, orgId: a.orgId };
  }

  private async saveVersion(trx: Tx, a: RequestActor, d: { id: string; workspaceId: string; version: number; title: string; contentHtml: string }) {
    await trx.insertInto('documentVersions').values({
      organizationId: a.orgId, workspaceId: d.workspaceId, documentId: d.id, version: d.version, title: d.title, contentHtml: d.contentHtml, createdBy: a.userId,
    }).execute();
  }

  private async assertProject(trx: Tx, workspaceId: string, projectId: string | null | undefined) {
    if (!projectId) return;
    const p = await trx.selectFrom('projects').select('id').where('id', '=', projectId).where('workspaceId', '=', workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!p) throw new AppError('VALIDATION_FAILED', 'Project not found in this workspace');
  }

  async list(a: RequestActor, q: { page?: number; pageSize?: number; workspaceId?: string; projectId?: string }): Promise<{ items: DocumentSummary[]; meta: PageMeta }> {
    const params = normalizePage(q);
    return this.dbs.run(this.ctx(a), async (trx) => {
      let base = trx.selectFrom('documents').where('deletedAt', 'is', null);
      if (q.workspaceId) base = base.where('workspaceId', '=', q.workspaceId);
      if (q.projectId) base = base.where('projectId', '=', q.projectId);
      const total = Number((await base.select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
      const { skip, take } = toSkipTake(params);
      const items = await base.select(SUMMARY).orderBy('updatedAt', 'desc').orderBy('id').limit(take).offset(skip).execute();
      return { items, meta: buildPageMeta(params, total) };
    });
  }

  get(a: RequestActor, id: string): Promise<DocumentDto> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const d = await trx.selectFrom('documents').select([...SUMMARY, 'contentHtml']).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!d) throw new AppError('NOT_FOUND');
      return d;
    });
  }

  create(a: RequestActor, input: CreateDocumentInput): Promise<DocumentDto> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      // RLS hides workspaces the caller cannot see, so this doubles as the access check
      const ws = await trx.selectFrom('workspaces').select('id').where('id', '=', input.workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!ws) throw new AppError('NOT_FOUND', 'Workspace not found');
      await this.assertProject(trx, input.workspaceId, input.projectId);
      const contentHtml = sanitizeDocumentHtml(input.contentHtml);
      const d = await trx.insertInto('documents')
        .values({ organizationId: a.orgId, workspaceId: input.workspaceId, projectId: input.projectId ?? null, title: input.title, contentHtml, createdBy: a.userId, updatedBy: a.userId })
        .returning([...SUMMARY, 'contentHtml']).executeTakeFirstOrThrow();
      await this.saveVersion(trx, a, d);
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: d.workspaceId, action: 'document.created', targetType: 'document', targetId: d.id, metadata: { title: d.title } }));
      await this.outbox.enqueue(trx, 'document.created.v1', { organizationId: a.orgId, workspaceId: d.workspaceId, documentId: d.id, version: 1, actorUserId: a.userId }, { orgId: a.orgId, workspaceId: d.workspaceId });
      return d;
    });
  }

  update(a: RequestActor, id: string, input: UpdateDocumentInput): Promise<DocumentDto> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const cur = await trx.selectFrom('documents').select(['workspaceId', 'version', 'title', 'contentHtml', 'projectId']).where('id', '=', id).where('deletedAt', 'is', null).forUpdate().executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND');
      if (cur.version !== input.expectedVersion) {
        throw new AppError('CONFLICT', 'This document was changed by someone else. Reload to see the latest version.', { currentVersion: cur.version });
      }
      if (input.projectId !== undefined) await this.assertProject(trx, cur.workspaceId, input.projectId);
      const next = {
        title: input.title ?? cur.title,
        contentHtml: input.contentHtml !== undefined ? sanitizeDocumentHtml(input.contentHtml) : cur.contentHtml,
        projectId: input.projectId !== undefined ? input.projectId : cur.projectId,
      };
      const d = await trx.updateTable('documents')
        .set({ ...next, version: cur.version + 1, updatedBy: a.userId, updatedAt: new Date() })
        .where('id', '=', id).returning([...SUMMARY, 'contentHtml']).executeTakeFirstOrThrow();
      await this.saveVersion(trx, a, d);
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: d.workspaceId, action: 'document.updated', targetType: 'document', targetId: id, metadata: { version: d.version } }));
      await this.outbox.enqueue(trx, 'document.updated.v1', { organizationId: a.orgId, workspaceId: d.workspaceId, documentId: id, version: d.version, actorUserId: a.userId }, { orgId: a.orgId, workspaceId: d.workspaceId });
      return d;
    });
  }

  remove(a: RequestActor, id: string): Promise<void> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const d = await trx.updateTable('documents').set({ deletedAt: new Date(), updatedBy: a.userId, updatedAt: new Date() })
        .where('id', '=', id).where('deletedAt', 'is', null).returning(['workspaceId', 'title']).executeTakeFirst();
      if (!d) throw new AppError('NOT_FOUND');
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: d.workspaceId, action: 'document.deleted', targetType: 'document', targetId: id, metadata: { title: d.title } }));
      await this.outbox.enqueue(trx, 'document.deleted.v1', { organizationId: a.orgId, workspaceId: d.workspaceId, documentId: id, actorUserId: a.userId }, { orgId: a.orgId, workspaceId: d.workspaceId });
    });
  }

  versions(a: RequestActor, id: string): Promise<VersionSummary[]> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const d = await trx.selectFrom('documents').select('id').where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!d) throw new AppError('NOT_FOUND');
      return trx.selectFrom('documentVersions').select(['version', 'title', 'createdBy', 'createdAt']).where('documentId', '=', id).orderBy('version', 'desc').execute();
    });
  }

  version(a: RequestActor, id: string, version: number): Promise<VersionSummary & { contentHtml: string }> {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const d = await trx.selectFrom('documents').select('id').where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst();
      if (!d) throw new AppError('NOT_FOUND');
      const v = await trx.selectFrom('documentVersions').select(['version', 'title', 'createdBy', 'createdAt', 'contentHtml']).where('documentId', '=', id).where('version', '=', version).executeTakeFirst();
      if (!v) throw new AppError('NOT_FOUND');
      return v;
    });
  }

  /** Restoring never rewrites history: it saves the old content as a NEW version. */
  async restore(a: RequestActor, id: string, version: number, expectedVersion: number): Promise<DocumentDto> {
    const old = await this.version(a, id, version);
    return this.update(a, id, { title: old.title, contentHtml: old.contentHtml, expectedVersion });
  }
}
