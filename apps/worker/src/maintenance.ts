import type { Job } from 'bullmq';
import { sql, withContext } from '@teamos/database';
import { syncAllCalendars, syncAllMailboxes, type GoogleDeps } from './google.processor';
import { syncAll, type IntegrationDeps } from './integration.processor';
import { deliver, type NotifyDeps } from './notify';

interface DueRow {
  taskId: string;
  organizationId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  identifier: string;
  assigneeId: string;
  dueDate: string;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Reminds assignees about tasks due today/tomorrow and tasks that are overdue (up to a week).
 * Safe to run as often as you like: each reminder has a dedupe key, so a user gets one per task/due date/kind.
 * "Today" is the server's UTC date — per-user time zones are not modelled yet.
 */
export async function runDueReminders(deps: NotifyDeps, now = new Date()): Promise<{ scanned: number; delivered: number }> {
  const today = isoDay(now);
  const rows = await withContext(deps.db, {}, (trx) =>
    sql<DueRow>`SELECT task_id AS "taskId", organization_id AS "organizationId", workspace_id AS "workspaceId",
                       project_id AS "projectId", title, identifier, assignee_id AS "assigneeId", due_date::text AS "dueDate"
                FROM job_tasks_due_soon(${today}::date)`.execute(trx),
  );
  let delivered = 0;
  for (const r of rows.rows) {
    const overdue = r.dueDate < today;
    const when = overdue ? 'is overdue' : r.dueDate === today ? 'is due today' : 'is due tomorrow';
    try {
      const res = await deliver(deps, {
        orgId: r.organizationId, workspaceId: r.workspaceId, userId: r.assigneeId, category: 'TASK_DUE',
        title: `${r.identifier} ${when}`, body: r.title,
        link: `/o/${r.organizationId}/projects/${r.projectId}?task=${r.taskId}`, taskId: r.taskId,
        dedupeKey: `${overdue ? 'overdue' : 'due'}:${r.taskId}:${r.dueDate}`,
      });
      if (res === 'delivered') delivered++;
    } catch (e) {
      deps.log?.(`due reminder for ${r.taskId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { scanned: rows.rows.length, delivered };
}

export async function runCleanup(deps: Pick<NotifyDeps, 'db'>, now = new Date()): Promise<Record<string, number>> {
  const r = await withContext(deps.db, {}, (trx) =>
    sql<{ step: string; removed: number }>`SELECT step, removed FROM job_cleanup(${now.toISOString()}::timestamptz)`.execute(trx),
  );
  return Object.fromEntries(r.rows.map((x) => [x.step, Number(x.removed)]));
}

/** Pending agent proposals past their deadline become EXPIRED so nobody can approve a stale suggestion. Idempotent. */
export async function runExpireAgentActions(deps: Pick<NotifyDeps, 'db'>, now = new Date()): Promise<{ expired: number }> {
  const r = await withContext(deps.db, {}, (trx) => sql<{ n: number }>`SELECT job_expire_agent_actions(${now.toISOString()}::timestamptz) AS n`.execute(trx));
  return { expired: Number(r.rows[0]?.n ?? 0) };
}

export function createMaintenanceProcessor(deps: NotifyDeps, integrations?: IntegrationDeps, google?: GoogleDeps) {
  return async function process(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'due-reminders':
        return runDueReminders(deps);
      case 'expire-agent-actions':
        return runExpireAgentActions(deps);
      case 'integration-sync':
        // disabled (no encryption key / client credentials): nothing can be connected, so nothing to do
        return integrations ? syncAll(integrations) : { skipped: 'integrations not configured' };
      case 'google-sync':
        return google ? { calendars: await syncAllCalendars(google), mailboxes: await syncAllMailboxes(google) } : { skipped: 'google not configured' };
      case 'cleanup':
        return runCleanup(deps);
      default:
        throw new Error(`unknown maintenance job "${job.name}"`);
    }
  };
}
