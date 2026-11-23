import { z } from 'zod';

/**
 * Versioned event contracts. A breaking change to a payload = a new `vN` entry;
 * consumers must support N and N-1 (see ARCHITECTURE.md §10).
 * Phase 1 events only; later phases append (project.*, task.*, agent.action.* ...).
 */

const uuid = z.string().uuid();

export const eventPayloadSchemas = {
  'user.registered.v1': z.object({ userId: uuid, email: z.string().email(), name: z.string() }),
  'user.email_verification_requested.v1': z.object({
    userId: uuid,
    email: z.string().email(),
    token: z.string(),
  }),
  'user.password_reset_requested.v1': z.object({
    userId: uuid,
    email: z.string().email(),
    token: z.string(),
  }),
  'org.created.v1': z.object({ organizationId: uuid, name: z.string(), ownerUserId: uuid }),
  'workspace.created.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    name: z.string(),
    createdByUserId: uuid,
  }),
  'member.invited.v1': z.object({
    organizationId: uuid,
    invitationId: uuid,
    email: z.string().email(),
    role: z.string(),
    token: z.string(),
    invitedByUserId: uuid,
    organizationName: z.string(),
  }),
  'member.joined.v1': z.object({ organizationId: uuid, userId: uuid, role: z.string() }),
  'member.role_changed.v1': z.object({
    organizationId: uuid,
    userId: uuid,
    previousRole: z.string(),
    newRole: z.string(),
    changedByUserId: uuid,
  }),
  'member.removed.v1': z.object({
    organizationId: uuid,
    userId: uuid,
    removedByUserId: uuid,
  }),
  'project.created.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    name: z.string(),
    createdByUserId: uuid,
  }),
  'task.created.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    taskId: uuid,
    title: z.string(),
    createdByUserId: uuid,
  }),
  'task.assigned.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    taskId: uuid,
    title: z.string(),
    assigneeId: uuid,
    previousAssigneeId: uuid.nullable(),
    assignedByUserId: uuid,
  }),
  'task.status_changed.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    taskId: uuid,
    title: z.string(),
    previousStatus: z.string(),
    newStatus: z.string(),
    changedByUserId: uuid,
  }),
  'task.commented.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    taskId: uuid,
    commentId: uuid,
    authorId: uuid,
  }),
  // --- realtime-only change events (no queue consumer; the relay turns them into live-update hints) ---
  'task.updated.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    taskId: uuid,
    fields: z.array(z.string()),
    changedByUserId: uuid,
  }),
  'task.deleted.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    taskId: uuid,
    deletedByUserId: uuid,
  }),
  'task.dependency_changed.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    taskId: uuid,
    changedByUserId: uuid,
  }),
  'project.updated.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    changedByUserId: uuid,
  }),
  'project.deleted.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    deletedByUserId: uuid,
  }),
  'milestone.changed.v1': z.object({
    organizationId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    changedByUserId: uuid,
  }),
  'document.created.v1': z.object({ organizationId: uuid, workspaceId: uuid, documentId: uuid, version: z.number().int(), actorUserId: uuid }),
  'document.updated.v1': z.object({ organizationId: uuid, workspaceId: uuid, documentId: uuid, version: z.number().int(), actorUserId: uuid }),
  'document.deleted.v1': z.object({ organizationId: uuid, workspaceId: uuid, documentId: uuid, actorUserId: uuid }),
  'meeting.created.v1': z.object({ organizationId: uuid, workspaceId: uuid, meetingId: uuid, actorUserId: uuid }),
  /** A person asked for (re)processing: transcribe if there is audio, then extract. */
  'meeting.processing_requested.v1': z.object({ organizationId: uuid, workspaceId: uuid, meetingId: uuid, actorUserId: uuid }),
  /** Emitted by the worker when processing finished (READY or FAILED), purely so clients refresh live. */
  'meeting.processed.v1': z.object({ organizationId: uuid, workspaceId: uuid, meetingId: uuid, status: z.enum(['READY', 'FAILED']) }),
  'meeting.updated.v1': z.object({ organizationId: uuid, workspaceId: uuid, meetingId: uuid, actorUserId: uuid }),
  'meeting.deleted.v1': z.object({ organizationId: uuid, workspaceId: uuid, meetingId: uuid, actorUserId: uuid }),
  // Agent proposals and their human decisions. Ids only: the proposal itself is read through the authorized API.
  'agent.action.proposed.v1': z.object({ organizationId: uuid, workspaceId: uuid, projectId: uuid, agentActionId: uuid, actorUserId: uuid }),
  'agent.action.approved.v1': z.object({ organizationId: uuid, workspaceId: uuid, projectId: uuid, agentActionId: uuid, actorUserId: uuid }),
  'agent.action.rejected.v1': z.object({ organizationId: uuid, workspaceId: uuid, projectId: uuid, agentActionId: uuid, actorUserId: uuid }),
  'agent.action.completed.v1': z.object({ organizationId: uuid, workspaceId: uuid, projectId: uuid, agentActionId: uuid, actorUserId: uuid, status: z.enum(['EXECUTED', 'FAILED', 'STALE']) }),
  // Integrations. The webhook event id points at the stored delivery; payloads are re-read from the database by the worker.
  'integration.webhook_received.v1': z.object({ organizationId: uuid, workspaceId: uuid, repoId: uuid, webhookEventId: uuid }),
  'integration.sync_requested.v1': z.object({ organizationId: uuid, workspaceId: uuid, repoId: uuid, requestedByUserId: uuid }),
  'integration.connected.v1': z.object({ organizationId: uuid, integrationId: uuid, actorUserId: uuid }),
  'integration.disconnected.v1': z.object({ organizationId: uuid, integrationId: uuid, actorUserId: uuid }),
  'integration.google_sync_requested.v1': z.object({ organizationId: uuid, workspaceId: uuid, kind: z.enum(['CALENDAR', 'MAIL']), sourceId: uuid, requestedByUserId: uuid }),
  'calendar.synced.v1': z.object({ organizationId: uuid, workspaceId: uuid, sourceId: uuid }),
  'email.processed.v1': z.object({ organizationId: uuid, workspaceId: uuid, messageId: uuid }),
  'github.pull_request.updated.v1': z.object({ organizationId: uuid, workspaceId: uuid, repoId: uuid, itemId: uuid, number: z.string(), state: z.enum(['open', 'closed', 'merged']).nullable() }),
} as const;

export type EventType = keyof typeof eventPayloadSchemas;
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloadSchemas)[T]>;

export const EVENT_TYPES = Object.keys(eventPayloadSchemas) as EventType[];

export function isEventType(value: string): value is EventType {
  return value in eventPayloadSchemas;
}

export function parseEventPayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return eventPayloadSchemas[type].parse(payload) as EventPayload<T>;
}

/** Which BullMQ queue handles an event type. Unmapped types are marked published with no queue (fine for P1). */
export type QueueTarget = 'email' | 'notifications' | 'knowledge' | 'meetings' | 'integrations';
export const EVENT_QUEUE: Partial<Record<EventType, QueueTarget>> = {
  'user.email_verification_requested.v1': 'email',
  'user.password_reset_requested.v1': 'email',
  'member.invited.v1': 'email',
  'task.assigned.v1': 'notifications',
  'task.commented.v1': 'notifications',
  'task.status_changed.v1': 'notifications',
  'document.created.v1': 'knowledge',
  'document.updated.v1': 'knowledge',
  'document.deleted.v1': 'knowledge',
  'meeting.processing_requested.v1': 'meetings',
  'integration.webhook_received.v1': 'integrations',
  'integration.sync_requested.v1': 'integrations',
  'integration.google_sync_requested.v1': 'integrations',
  // keeps the knowledge index in step with deletes/edits; the indexer re-reads live state
  'meeting.deleted.v1': 'meetings',
};

/**
 * Live-update hints sent to browsers. A hint is ONLY ids + the event type: it never carries payload
 * content (member.invited contains a secret token; task titles may be private to a workspace).
 * Clients react by re-fetching through the normal, authorized API.
 */
export interface RealtimeHint {
  type: string;
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  documentId?: string;
  meetingId?: string;
  agentActionId?: string;
}

const HINT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'project.created.v1', 'project.updated.v1', 'project.deleted.v1', 'milestone.changed.v1',
  'task.created.v1', 'task.updated.v1', 'task.deleted.v1', 'task.assigned.v1', 'task.status_changed.v1',
  'task.commented.v1', 'task.dependency_changed.v1',
  'document.created.v1', 'document.updated.v1', 'document.deleted.v1',
  'meeting.created.v1', 'meeting.updated.v1', 'meeting.deleted.v1', 'meeting.processed.v1', 'meeting.processing_requested.v1',
  'agent.action.proposed.v1', 'agent.action.approved.v1', 'agent.action.rejected.v1', 'agent.action.completed.v1',
  'integration.connected.v1', 'integration.disconnected.v1', 'github.pull_request.updated.v1', 'integration.sync_requested.v1',
  'integration.google_sync_requested.v1', 'calendar.synced.v1', 'email.processed.v1',
  'workspace.created.v1', 'member.joined.v1', 'member.role_changed.v1', 'member.removed.v1',
]);

export function toRealtimeHint(type: string, payload: unknown): RealtimeHint | null {
  if (!HINT_TYPES.has(type)) return null;
  const p = (payload ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  const hint: RealtimeHint = { type: type.replace(/\.v\d+$/, '') };
  const [ws, pr, tk] = [pick('workspaceId'), pick('projectId'), pick('taskId')];
  const doc = pick('documentId');
  const mt = pick('meetingId');
  if (ws) hint.workspaceId = ws;
  if (pr) hint.projectId = pr;
  if (tk) hint.taskId = tk;
  if (doc) hint.documentId = doc;
  if (mt) hint.meetingId = mt;
  const aa = pick('agentActionId');
  if (aa) hint.agentActionId = aa;
  return hint;
}

/** Redis pub/sub channels used for live updates. */
export const rtOrgChannel = (orgId: string) => `rt:org:${orgId}`;
export const rtUserChannel = (userId: string) => `rt:user:${userId}`;

export type RealtimeMessage =
  | { k: 'hint'; hint: RealtimeHint }
  | { k: 'notification'; notification: { id: string; category: string; title: string; link: string | null } };
