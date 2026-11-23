import { z } from 'zod';
import { paginationQuerySchema, uuidSchema } from './common';

const title = z.string().trim().min(1, 'Title is required').max(200);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

export const createMeetingSchema = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema.nullish(),
  title,
  heldAt: z.string().datetime({ offset: true }).nullish(),
  transcript: z.string().max(400_000).nullish(),
});
export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;

export const updateMeetingSchema = z
  .object({
    title: title.optional(),
    projectId: uuidSchema.nullable().optional(),
    heldAt: z.string().datetime({ offset: true }).nullable().optional(),
    transcript: z.string().max(400_000).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update');
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;

export const listMeetingsQuerySchema = paginationQuerySchema.extend({
  workspaceId: uuidSchema.optional(),
  projectId: uuidSchema.optional(),
});

/** A person correcting what the AI proposed, before deciding on it. */
export const updateMeetingItemSchema = z
  .object({ text: z.string().trim().min(1).max(500).optional(), dueDate: isoDate.nullable().optional(), priority: priority.nullable().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update');
export type UpdateMeetingItemInput = z.infer<typeof updateMeetingItemSchema>;

export const approveMeetingItemSchema = z.object({
  /** required for action items: where the new task goes */
  projectId: uuidSchema.optional(),
  assigneeId: uuidSchema.nullish(),
  dueDate: isoDate.nullish(),
  priority: priority.nullish(),
  text: z.string().trim().min(1).max(300).optional(),
});
export type ApproveMeetingItemInput = z.infer<typeof approveMeetingItemSchema>;

export const planRequestSchema = z.object({ goal: z.string().trim().max(4000).optional() });
export type PlanRequestInput = z.infer<typeof planRequestSchema>;

const planTask = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(2000).nullish(),
  priority: priority.nullish(),
  estimateHours: z.number().min(0).max(1000).nullish(),
  dependsOn: z.array(z.number().int().min(0)).max(10).default([]),
});
/** The human-reviewed plan. Dependencies may only point at EARLIER tasks, which makes cycles impossible. */
export const applyPlanSchema = z
  .object({ tasks: z.array(planTask).min(1).max(40) })
  .refine((v) => v.tasks.every((t, i) => t.dependsOn.every((d) => d < i)), 'A task can only depend on tasks listed before it');
export type ApplyPlanInput = z.infer<typeof applyPlanSchema>;
