import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  createDocumentSchema,
  listDocumentsQuerySchema,
  restoreVersionSchema,
  updateDocumentSchema,
  uuidSchema,
  type CreateDocumentInput,
  type UpdateDocumentInput,
} from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { CurrentActor, RequirePermission } from '../../common/decorators';
import { Paged } from '../../common/envelope';
import { ZodPipe } from '../../common/zod.pipe';
import { DocumentsService } from './documents.service';

const id = () => new ZodPipe(uuidSchema);

@Controller('organizations/:orgId/documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly docs: DocumentsService) {}

  @Get()
  @RequirePermission('document:read')
  async list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listDocumentsQuerySchema)) q: z.infer<typeof listDocumentsQuerySchema>) {
    const { items, meta } = await this.docs.list(a, q);
    return new Paged(items, meta);
  }

  @Post()
  @RequirePermission('document:write')
  create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(createDocumentSchema)) body: CreateDocumentInput) {
    return this.docs.create(a, body);
  }

  @Get(':documentId')
  @RequirePermission('document:read')
  get(@CurrentActor() a: RequestActor, @Param('documentId', id()) docId: string) {
    return this.docs.get(a, docId);
  }

  @Patch(':documentId')
  @RequirePermission('document:write')
  update(@CurrentActor() a: RequestActor, @Param('documentId', id()) docId: string, @Body(new ZodPipe(updateDocumentSchema)) body: UpdateDocumentInput) {
    return this.docs.update(a, docId, body);
  }

  @Delete(':documentId')
  @HttpCode(200)
  @RequirePermission('document:write')
  async remove(@CurrentActor() a: RequestActor, @Param('documentId', id()) docId: string) {
    await this.docs.remove(a, docId);
    return { deleted: true };
  }

  @Get(':documentId/versions')
  @RequirePermission('document:read')
  versions(@CurrentActor() a: RequestActor, @Param('documentId', id()) docId: string) {
    return this.docs.versions(a, docId);
  }

  @Get(':documentId/versions/:version')
  @RequirePermission('document:read')
  version(@CurrentActor() a: RequestActor, @Param('documentId', id()) docId: string, @Param('version', ParseIntPipe) v: number) {
    return this.docs.version(a, docId, v);
  }

  @Post(':documentId/versions/:version/restore')
  @HttpCode(200)
  @RequirePermission('document:write')
  restore(
    @CurrentActor() a: RequestActor,
    @Param('documentId', id()) docId: string,
    @Param('version', ParseIntPipe) v: number,
    @Body(new ZodPipe(restoreVersionSchema)) body: { expectedVersion: number },
  ) {
    return this.docs.restore(a, docId, v, body.expectedVersion);
  }
}
