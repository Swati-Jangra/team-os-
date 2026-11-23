import type { Job } from 'bullmq';
import { sql, withContext } from '@teamos/database';
import { parseEventPayload, type EventPayload, type EventType } from '@teamos/event-contracts';
import { deliver, type Delivery, type NotifyDeps } from './notify';
import type { JobData } from './queues';

interface TaskCtx {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  identifier: string;
  assigneeId: string | null;
  reporterId: string;
}

const taskLink = (orgId: string, projectId: string, taskId: string) => `/o/${orgId}/projects/${projectId}?task=${taskId}`;

/**
 * Turns task events into notifications. Recipients are resolved at processing time (not trusted from the
 * event), each delivery is idempotent via `evt:<eventId>`, and any per-recipient failure fails the job so
 * BullMQ retries it — already-delivered recipients are skipped by the dedupe key.
 */
export function createNotificationProcessor(deps: NotifyDeps) {
  const nameOf = async (orgId: string, viewerId: string, userId: string): Promise<string> => {
    const r = await withContext(deps.db, { userId: viewerId, orgId }, (trx) =>
      trx.selectFrom('users').select('name').where('id', '=', userId).executeTakeFirst(),
    );
    return r?.name ?? 'Someone';
  };

  const loadTask = async (taskId: string): Promise<TaskCtx | null> => {
    const r = await withContext(deps.db, {}, (trx) =>
      sql<TaskCtx>`SELECT organization_id AS "organizationId", workspace_id AS "workspaceId", project_id AS "projectId",
                          title, identifier, assignee_id AS "assigneeId", reporter_id AS "reporterId"
                   FROM job_task_context(${taskId}::uuid)`.execute(trx),
    );
    return r.rows[0] ?? null;
  };

  return async function process(job: Job<JobData>): Promise<{ delivered: number; skipped: number }> {
    const { eventId, type, payload } = job.data;
    const t = type as EventType;
    const deliveries: Delivery[] = [];
    const key = `evt:${eventId}`;

    switch (t) {
      case 'task.assigned.v1': {
        const p = parseEventPayload(t, payload) as EventPayload<'task.assigned.v1'>;
        if (p.assigneeId === p.assignedByUserId) break; // self-assignment needs no notification
        const task = await loadTask(p.taskId);
        if (!task) break;
        const actor = await nameOf(p.organizationId, p.assigneeId, p.assignedByUserId);
        deliveries.push({
          orgId: p.organizationId, workspaceId: p.workspaceId, userId: p.assigneeId, category: 'TASK_ASSIGNED',
          title: `${actor} assigned you ${task.identifier}`, body: task.title,
          link: taskLink(p.organizationId, p.projectId, p.taskId), taskId: p.taskId, dedupeKey: key,
        });
        break;
      }
      case 'task.commented.v1': {
        const p = parseEventPayload(t, payload) as EventPayload<'task.commented.v1'>;
        const task = await loadTask(p.taskId);
        if (!task) break;
        const commenters = await withContext(deps.db, {}, (trx) =>
          sql<{ userId: string }>`SELECT user_id AS "userId" FROM job_task_commenters(${p.taskId}::uuid)`.execute(trx),
        );
        const recipients = new Set<string>([task.reporterId, ...commenters.rows.map((r) => r.userId)]);
        if (task.assigneeId) recipients.add(task.assigneeId);
        recipients.delete(p.authorId);
        for (const userId of recipients) {
          const actor = await nameOf(p.organizationId, userId, p.authorId);
          deliveries.push({
            orgId: p.organizationId, workspaceId: p.workspaceId, userId, category: 'TASK_COMMENT',
            title: `${actor} commented on ${task.identifier}`, body: task.title,
            link: taskLink(p.organizationId, p.projectId, p.taskId), taskId: p.taskId, dedupeKey: key,
          });
        }
        break;
      }
      case 'task.status_changed.v1': {
        const p = parseEventPayload(t, payload) as EventPayload<'task.status_changed.v1'>;
        const task = await loadTask(p.taskId);
        if (!task) break;
        const recipients = new Set<string>([task.reporterId]);
        if (task.assigneeId) recipients.add(task.assigneeId);
        recipients.delete(p.changedByUserId);
        const label = p.newStatus.toLowerCase().replace(/_/g, ' ');
        for (const userId of recipients) {
          const actor = await nameOf(p.organizationId, userId, p.changedByUserId);
          deliveries.push({
            orgId: p.organizationId, workspaceId: p.workspaceId, userId, category: 'TASK_STATUS',
            title: `${task.identifier} moved to ${label}`, body: `${actor}: ${task.title}`,
            link: taskLink(p.organizationId, p.projectId, p.taskId), taskId: p.taskId, dedupeKey: key,
          });
        }
        break;
      }
      default:
        throw new Error(`notification processor cannot handle ${type}`);
    }

    let delivered = 0;
    let skipped = 0;
    const failures: string[] = [];
    for (const d of deliveries) {
      try {
        const r = await deliver(deps, d);
        if (r === 'delivered') delivered++;
        else skipped++;
      } catch (e) {
        failures.push(`${d.userId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failures.length > 0) throw new Error(`notification delivery failed for ${failures.length} recipient(s): ${failures.join('; ')}`);
    return { delivered, skipped };
  };
}
