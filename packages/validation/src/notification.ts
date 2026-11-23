import { z } from 'zod';
import { paginationQuerySchema } from './common';

export const NOTIFICATION_CATEGORIES = ['TASK_ASSIGNED', 'TASK_COMMENT', 'TASK_STATUS', 'TASK_DUE'] as const;
export type NotificationCategoryName = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_META: Record<NotificationCategoryName, { label: string; description: string; inApp: boolean; email: boolean }> = {
  TASK_ASSIGNED: { label: 'Assigned to me', description: 'When someone assigns a task to you.', inApp: true, email: true },
  TASK_COMMENT: { label: 'Comments', description: 'New comments on tasks you created, are assigned to, or commented on.', inApp: true, email: false },
  TASK_STATUS: { label: 'Status changes', description: 'When a task you created or are assigned to changes status.', inApp: true, email: false },
  TASK_DUE: { label: 'Due dates', description: 'Reminders for tasks due soon or overdue.', inApp: true, email: true },
};

/** Effective settings: stored rows win, missing rows fall back to the defaults above. */
export function effectivePreference(
  category: NotificationCategoryName,
  stored: ReadonlyArray<{ category: string; inApp: boolean; email: boolean }>,
): { inApp: boolean; email: boolean } {
  const row = stored.find((r) => r.category === category);
  return row ? { inApp: row.inApp, email: row.email } : { inApp: NOTIFICATION_META[category].inApp, email: NOTIFICATION_META[category].email };
}

export const updateNotificationPreferencesSchema = z.object({
  preferences: z
    .array(z.object({ category: z.enum(NOTIFICATION_CATEGORIES), inApp: z.boolean(), email: z.boolean() }))
    .min(1)
    .max(NOTIFICATION_CATEGORIES.length)
    .refine((a) => new Set(a.map((p) => p.category)).size === a.length, 'Duplicate category'),
});
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;

export const listNotificationsQuerySchema = paginationQuerySchema.extend({
  unread: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
