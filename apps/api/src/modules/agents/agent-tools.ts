import { sql, type Tx } from '@teamos/database';
import { hasPermission, type Permission } from '@teamos/permissions';
import { AppError, type RiskDependency, type RiskTask } from '@teamos/shared';
import type { RequestActor } from '../../common/actor';
import type { DbService } from '../../db/db.service';

export interface SnapshotTask extends RiskTask {
  version: string; // tasks.updated_at at full precision; what an approval is later checked against
  assigneeName: string | null;
}
export interface ProjectSnapshot {
  project: { id: string; workspaceId: string; key: string; name: string; dueDate: string | null };
  tasks: SnapshotTask[];
  dependencies: RiskDependency[];
}
export interface Assignee {
  userId: string;
  name: string;
  openTasks: number;
}

/**
 * The only way an agent reads business data. Typed, narrow tools — an agent never gets a database handle or
 * free-form queries. Every tool (1) requires the acting user's permission, (2) runs under that user's
 * row-level security (so workspace visibility and tenant isolation apply exactly as they do for the user),
 * and (3) never accepts an organization/user id from the model.
 */
export class AgentToolbox {
  constructor(private readonly dbs: DbService, private readonly actor: RequestActor) {}

  private need(...perms: Permission[]) {
    for (const p of perms) if (!hasPermission(this.actor.role, p)) throw new AppError('FORBIDDEN', 'You do not have permission to use this tool');
  }
  private run<T>(fn: (trx: Tx) => Promise<T>) {
    return this.dbs.run({ userId: this.actor.userId, orgId: this.actor.orgId }, fn);
  }

  /** Open (planning/active) projects the user can see, with their tasks and dependency edges. */
  async projectSnapshots(opts: { projectId?: string; workspaceId?: string } = {}): Promise<ProjectSnapshot[]> {
    this.need('project:read', 'task:read');
    return this.run(async (trx) => {
      let q = trx.selectFrom('projects').select(['id', 'workspaceId', 'key', 'name', 'dueDate']).where('deletedAt', 'is', null);
      if (opts.projectId) q = q.where('id', '=', opts.projectId);
      else q = q.where('status', 'in', ['PLANNING', 'ACTIVE']);
      if (opts.workspaceId) q = q.where('workspaceId', '=', opts.workspaceId);
      const projects = await q.orderBy('name').orderBy('id').limit(100).execute();
      if (opts.projectId && projects.length === 0) throw new AppError('NOT_FOUND');
      if (projects.length === 0) return [];
      const ids = projects.map((p) => p.id);
      const tasks = await trx
        .selectFrom('tasks as t')
        .innerJoin('projects as p', 'p.id', 't.projectId')
        .leftJoin('users as u', 'u.id', 't.assigneeId')
        .select(['t.id', 't.projectId', 'p.key', 't.number', 't.title', 't.status', 't.dueDate', 't.assigneeId', 'u.name as assigneeName', sql<string>`t.updated_at::text`.as('version')])
        .where('t.projectId', 'in', ids)
        .where('t.deletedAt', 'is', null)
        .execute();
      const deps = await trx
        .selectFrom('taskDependencies as d')
        .innerJoin('tasks as t', 't.id', 'd.taskId')
        .select(['d.taskId', 'd.dependsOnTaskId', 't.projectId'])
        .where('t.projectId', 'in', ids)
        .execute();
      return projects.map((p) => ({
        project: p,
        tasks: tasks.filter((t) => t.projectId === p.id).map((t) => ({
          id: t.id, identifier: `${t.key}-${t.number}`, title: t.title, status: t.status, dueDate: t.dueDate, assigneeId: t.assigneeId, assigneeName: t.assigneeName, version: t.version,
        })),
        dependencies: deps.filter((d) => d.projectId === p.id).map((d) => ({ taskId: d.taskId, dependsOnTaskId: d.dependsOnTaskId })),
      }));
    });
  }

  /** People tasks can reasonably be assigned to in a workspace, with their current open workload. */
  async workspaceAssignees(workspaceId: string): Promise<Assignee[]> {
    this.need('member:read', 'task:read');
    return this.run(async (trx) => {
      const rows = await trx
        .selectFrom('workspaceMembers as wm')
        .innerJoin('organizationMembers as om', (j) => j.onRef('om.userId', '=', 'wm.userId').on('om.organizationId', '=', this.actor.orgId))
        .innerJoin('users as u', 'u.id', 'wm.userId')
        .select(['wm.userId', 'u.name', 'om.role'])
        .where('wm.workspaceId', '=', workspaceId)
        .where('wm.deletedAt', 'is', null)
        .where('om.deletedAt', 'is', null)
        .execute();
      const eligible = rows.filter((r) => hasPermission(r.role, 'task:update'));
      if (eligible.length === 0) return [];
      const load = await trx
        .selectFrom('tasks')
        .select(['assigneeId', (eb) => eb.fn.countAll().as('n')])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where('status', 'not in', ['DONE', 'CANCELLED'])
        .where('assigneeId', 'in', eligible.map((e) => e.userId))
        .groupBy('assigneeId')
        .execute();
      const n = new Map(load.map((l) => [l.assigneeId, Number(l.n)]));
      return eligible.map((e) => ({ userId: e.userId, name: e.name, openTasks: n.get(e.userId) ?? 0 }));
    });
  }
}
