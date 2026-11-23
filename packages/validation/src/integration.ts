import { z } from 'zod';
import { paginationQuerySchema, uuidSchema } from './common';

export const repoFullNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'Use owner/name');

export const connectRepoSchema = z.object({
  fullName: repoFullNameSchema,
  workspaceId: uuidSchema,
  projectId: uuidSchema.nullish(),
});
export type ConnectRepoInput = z.infer<typeof connectRepoSchema>;

export const oauthCallbackQuerySchema = z.object({ code: z.string().min(1).max(500).optional(), state: z.string().min(16).max(200), error: z.string().max(100).optional() });

export const listExternalItemsQuerySchema = paginationQuerySchema.extend({
  workspaceId: uuidSchema.optional(),
  kind: z.enum(['PULL_REQUEST', 'ISSUE', 'COMMIT']).optional(),
  q: z.string().trim().max(100).optional(),
});

export const linkItemSchema = z.object({ itemId: uuidSchema });
export type LinkItemInput = z.infer<typeof linkItemSchema>;

// ---- Google (Calendar + Gmail)
export const connectCalendarSchema = z.object({ calendarId: z.string().trim().min(1).max(300), workspaceId: uuidSchema });
export type ConnectCalendarInput = z.infer<typeof connectCalendarSchema>;
export const listCalendarEventsQuerySchema = z.object({
  workspaceId: uuidSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const linkMeetingEventSchema = z.object({ eventId: uuidSchema });

export const labelNameSchema = z.string().trim().regex(/^[A-Za-z0-9 _\-/]{1,100}$/, 'Letters, numbers, spaces, - _ / only');
export const connectMailboxSchema = z.object({ workspaceId: uuidSchema, projectId: uuidSchema.nullish(), label: labelNameSchema.default('TeamOS') });
export type ConnectMailboxInput = z.infer<typeof connectMailboxSchema>;
export const listEmailsQuerySchema = paginationQuerySchema.extend({
  workspaceId: uuidSchema.optional(),
  status: z.enum(['RECEIVED', 'EXTRACTED', 'FAILED']).optional(),
  linked: z.enum(['true', 'false']).optional(),
});
export const linkEmailProjectSchema = z.object({ projectId: uuidSchema.nullable() });
