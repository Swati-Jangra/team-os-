import { z } from 'zod';
import { paginationQuerySchema, uuidSchema } from './common';

const title = z.string().trim().min(1, 'Title is required').max(200);
const html = z.string().max(500_000, 'Document is too large');

export const createDocumentSchema = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema.nullish(),
  title,
  contentHtml: html.default(''),
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

/** `expectedVersion` gives optimistic concurrency: a stale editor gets a 409 instead of silently overwriting. */
export const updateDocumentSchema = z
  .object({
    title: title.optional(),
    contentHtml: html.optional(),
    projectId: uuidSchema.nullable().optional(),
    expectedVersion: z.number().int().positive(),
  })
  .refine((v) => v.title !== undefined || v.contentHtml !== undefined || v.projectId !== undefined, 'Nothing to update');
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const listDocumentsQuerySchema = paginationQuerySchema.extend({
  workspaceId: uuidSchema.optional(),
  projectId: uuidSchema.optional(),
});

export const restoreVersionSchema = z.object({ expectedVersion: z.number().int().positive() });

export const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(2, 'Enter at least 2 characters').max(500),
  workspaceId: uuidSchema.optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchSchema>;

export const askSchema = z.object({
  question: z.string().trim().min(3).max(1000),
  workspaceId: uuidSchema.optional(),
});
export type AskInput = z.infer<typeof askSchema>;
