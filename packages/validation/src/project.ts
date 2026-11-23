import { z } from 'zod';
import { nameSchema, uuidSchema } from './common';

export const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'] as const;
export const MILESTONE_STATUSES = ['OPEN', 'COMPLETED'] as const;
export const TASK_STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'] as const;
export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid date');
const description = z.string().trim().max(20_000);

const datesOrdered = <T extends { startDate?: string | null; dueDate?: string | null }>(v: T) =>
  !v.startDate || !v.dueDate || v.dueDate >= v.startDate;
const DATES_MSG = { message: 'Due date must be on or after the start date', path: ['dueDate'] };

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Use 2–10 letters/numbers, starting with a letter');

export const createProjectSchema = z
  .object({
    workspaceId: uuidSchema,
    name: nameSchema,
    key: projectKeySchema.optional(),
    description: description.optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    ownerId: uuidSchema.nullable().optional(),
    startDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
  })
  .refine(datesOrdered, DATES_MSG);
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: nameSchema.optional(),
    description: description.nullable().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    ownerId: uuidSchema.nullable().optional(),
    startDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required')
  .refine(datesOrdered, DATES_MSG);
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const listProjectsQuerySchema = z.object({
  workspaceId: uuidSchema.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});

export const createMilestoneSchema = z.object({
  name: nameSchema,
  description: description.optional(),
  dueDate: isoDate.nullable().optional(),
});
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;

export const updateMilestoneSchema = z
  .object({
    name: nameSchema.optional(),
    description: description.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    status: z.enum(MILESTONE_STATUSES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;

const labels = z.array(z.string().trim().min(1).max(30)).max(10);

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: description.optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assigneeId: uuidSchema.nullable().optional(),
    milestoneId: uuidSchema.nullable().optional(),
    startDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    estimateHours: z.number().min(0).max(10_000).nullable().optional(),
    labels: labels.optional(),
  })
  .refine(datesOrdered, DATES_MSG);
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: description.nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assigneeId: uuidSchema.nullable().optional(),
    milestoneId: uuidSchema.nullable().optional(),
    startDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    estimateHours: z.number().min(0).max(10_000).nullable().optional(),
    labels: labels.optional(),
    /** Board ordering within a column. */
    position: z.number().finite().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required')
  .refine(datesOrdered, DATES_MSG);
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const listTasksQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: uuidSchema.optional(),
  milestoneId: uuidSchema.optional(),
  q: z.string().trim().max(100).optional(),
});

export const addDependencySchema = z.object({ dependsOnTaskId: uuidSchema });
export type AddDependencyInput = z.infer<typeof addDependencySchema>;

export const commentBodySchema = z.object({ body: z.string().trim().min(1).max(10_000) });
export type CommentBodyInput = z.infer<typeof commentBodySchema>;
