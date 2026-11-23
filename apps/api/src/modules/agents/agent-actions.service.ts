import { Inject, Injectable } from '@nestjs/common';
import { sql, type AgentActionStatus, type AgentActionType, type AgentName, type Tx } from '@teamos/database';
import { hasPermission, type Permission } from '@teamos/permissions';
import { actionHash, addDays, AppError, buildPageMeta, computeSlip, isFinished, normalizePage, toSkipTake, type PageMeta } from '@teamos/shared';
import type { RequestActor } from '../../common/actor';
import type { RateLimiter } from '../../common/rate-limit/rate-limiter';
import { RATE_LIMITER } from '../../common/tokens';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { TasksService } from '../projects/tasks.service';
import { AgentToolbox } from './agent-tools';

export interface AgentActionDto {
  id: string;
  workspaceId: string;
  projectId: string;
  agent: AgentName;
  actionType: AgentActionType;
  targetTaskId: string;
  targetIdentifier: string | null;
  targetTitle: string | null;
  payload: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  rationale: string;
  evidence: unknown[];
  status: AgentActionStatus;
  proposedBy: string;
  proposedByName: string | null;
  expiresAt: Date;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  attempts: number;
  lastError: string | null;
  executedAt: Date | null;
  createdAt: Date;
}

const EXPIRY_DAYS = 7;
const MAX_ATTEMPTS = 3;
const MAX_PROPOSALS_PER_RUN = 25;
/** The permission the APPROVER must hold for the change to be applied (checked again right before execution). */
const NEEDED: Record<AgentActionType, Permission> = { TASK_UPDATE_DUE: 'task:update', TASK_ASSIGN: 'task:assign' };

interface Draft {
  workspaceId: string;
  projectId: string;
  agent: AgentName;
  actionType: AgentActionType;
  targetTaskId: string;
  targetVersion: string;
  payload: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  rationale: string;
  evidence: unknown[];
}

@Injectable()
export class AgentActionsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  private ctx(a: RequestActor) {
    return { userId: a.userId, orgId: a.orgId };
  }

  // ------------------------------------------------------------------ proposing (agents never change data)

  /** Runs the agent(s) over the user's own view of the project and stores PENDING proposals. */
  async propose(actor: RequestActor, projectId: string, which?: AgentName): Promise<AgentActionDto[]> {
    const r = await this.limiter.hit(`agent:propose:${actor.userId}`, 3600);
    if (r.count > 30) throw new AppError('RATE_LIMITED', 'Too many agent runs. Try again later.', { retryAfterSec: r.retryAfterSec });
    const tools = new AgentToolbox(this.dbs, actor);
    const [snap] = await tools.projectSnapshots({ projectId });
    if (!snap) throw new AppError('NOT_FOUND');
    const today = new Date().toISOString().slice(0, 10);
    const drafts: Draft[] = [];

    if (!which || which === 'DEPENDENCY_RISK') {
      const slip = computeSlip({ tasks: snap.tasks, dependencies: snap.dependencies, today });
      const byId = new Map(snap.tasks.map((t) => [t.id, t]));
      for (const t of snap.tasks) {
        const s = slip.get(t.id);
        // only downstream work is moved; the late task's own date is its owner's call
        if (isFinished(t.status) || !t.dueDate || !s || s.own > 0 || s.slip <= 0) continue;
        const newDue = addDays(t.dueDate, s.slip);
        const causes = s.causes.map((c) => byId.get(c)?.identifier ?? c);
        drafts.push({
          workspaceId: snap.project.workspaceId, projectId, agent: 'DEPENDENCY_RISK', actionType: 'TASK_UPDATE_DUE', targetTaskId: t.id, targetVersion: t.version,
          payload: { dueDate: newDue }, before: { dueDate: t.dueDate }, after: { dueDate: newDue },
          rationale: `${t.identifier} depends on late work (${causes.join(', ')}), so it will probably slip about ${s.slip} day${s.slip === 1 ? '' : 's'}. Moving its due date keeps the plan honest.`,
          evidence: [{ basis: 'FACT', text: `${causes.join(', ')} ${causes.length === 1 ? 'is' : 'are'} overdue` }, { basis: 'INFERRED', text: `${t.identifier} slips ${s.slip} day(s)` }],
        });
      }
    }

    if (!which || which === 'TASK_MANAGEMENT') {
      const people = await tools.workspaceAssignees(snap.project.workspaceId);
      const load = new Map(people.map((p) => [p.userId, p.openTasks]));
      const soon = addDays(today, 14);
      const unassigned = snap.tasks.filter((t) => !isFinished(t.status) && !t.assigneeId && t.dueDate && t.dueDate <= soon).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
      for (const t of unassigned) {
        const pick = [...people].sort((a, b) => load.get(a.userId)! - load.get(b.userId)! || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId))[0];
        if (!pick) break;
        const n = load.get(pick.userId)!;
        load.set(pick.userId, n + 1);
        drafts.push({
          workspaceId: snap.project.workspaceId, projectId, agent: 'TASK_MANAGEMENT', actionType: 'TASK_ASSIGN', targetTaskId: t.id, targetVersion: t.version,
          payload: { assigneeId: pick.userId }, before: { assigneeId: null, assigneeName: null }, after: { assigneeId: pick.userId, assigneeName: pick.name },
          rationale: `${t.identifier} is due ${t.dueDate} and has no owner. ${pick.name} has the fewest open tasks in this workspace (${n}).`,
          evidence: [{ basis: 'FACT', text: `${t.identifier} has no assignee and is due ${t.dueDate}` }, { basis: 'FACT', text: `${pick.name} has ${n} open task(s)` }],
        });
      }
    }

    const ids = await this.dbs.run(this.ctx(actor), async (trx) => {
      const out: string[] = [];
      for (const d of drafts.slice(0, MAX_PROPOSALS_PER_RUN)) {
        const row = await trx
          .insertInto('agentActions')
          .values({
            organizationId: actor.orgId, workspaceId: d.workspaceId, projectId: d.projectId, agent: d.agent, actionType: d.actionType, targetTaskId: d.targetTaskId,
            targetVersion: d.targetVersion, payload: JSON.stringify(d.payload), payloadHash: actionHash({ actionType: d.actionType, targetTaskId: d.targetTaskId, payload: d.payload }),
            beforeState: JSON.stringify(d.before), afterState: JSON.stringify(d.after), rationale: d.rationale, evidence: JSON.stringify(d.evidence),
            proposedBy: actor.userId, expiresAt: new Date(Date.now() + EXPIRY_DAYS * 86_400_000),
          })
          .onConflict((oc) => oc.columns(['targetTaskId', 'actionType']).where('status', '=', 'PENDING').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!row) continue; // an identical kind of proposal is already waiting for this task
        out.push(row.id);
        // proposals are made by the AI on behalf of the requesting user
        await this.audit.record(trx, { orgId: actor.orgId, workspaceId: d.workspaceId, actorType: 'AI', actorId: null, action: 'agent_action.proposed', targetType: 'agent_action', targetId: row.id,
          metadata: { agent: d.agent, actionType: d.actionType, targetTaskId: d.targetTaskId, requestedBy: actor.userId }, requestId: actor.requestId, ip: actor.ip });
        await this.outbox.enqueue(trx, 'agent.action.proposed.v1', { organizationId: actor.orgId, workspaceId: d.workspaceId, projectId, agentActionId: row.id, actorUserId: actor.userId }, { orgId: actor.orgId, workspaceId: d.workspaceId });
      }
      return out;
    });
    return ids.length ? this.dbs.run(this.ctx(actor), (trx) => this.fetch(trx, { ids })) : [];
  }

  // ------------------------------------------------------------------ reading

  private async fetch(trx: Tx, f: { ids?: string[]; status?: AgentActionStatus; projectId?: string; limit?: number; offset?: number }): Promise<AgentActionDto[]> {
    let q = trx
      .selectFrom('agentActions as a')
      .innerJoin('tasks as t', 't.id', 'a.targetTaskId')
      .innerJoin('projects as p', 'p.id', 'a.projectId')
      .leftJoin('users as pu', 'pu.id', 'a.proposedBy')
      .leftJoin('users as du', 'du.id', 'a.decidedBy')
      .select([
        'a.id', 'a.workspaceId', 'a.projectId', 'a.agent', 'a.actionType', 'a.targetTaskId', 't.title as targetTitle', 'p.key as projectKey', 't.number as taskNumber',
        'a.payload', 'a.beforeState as before', 'a.afterState as after', 'a.rationale', 'a.evidence', 'a.status', 'a.proposedBy', 'pu.name as proposedByName',
        'a.expiresAt', 'a.decidedBy', 'du.name as decidedByName', 'a.decidedAt', 'a.decisionNote', 'a.attempts', 'a.lastError', 'a.executedAt', 'a.createdAt',
      ]);
    if (f.ids) q = q.where('a.id', 'in', f.ids);
    if (f.status) q = q.where('a.status', '=', f.status);
    if (f.projectId) q = q.where('a.projectId', '=', f.projectId);
    q = q.orderBy('a.createdAt', 'desc').orderBy('a.id');
    if (f.limit !== undefined) q = q.limit(f.limit).offset(f.offset ?? 0);
    const rows = await q.execute();
    return rows.map(({ projectKey, taskNumber, ...r }) => ({ ...r, targetIdentifier: `${projectKey}-${taskNumber}` }));
  }

  async list(actor: RequestActor, q: { page?: number; pageSize?: number; status?: AgentActionStatus; projectId?: string }): Promise<{ items: AgentActionDto[]; meta: PageMeta }> {
    const params = normalizePage(q);
    return this.dbs.run(this.ctx(actor), async (trx) => {
      let c = trx.selectFrom('agentActions');
      if (q.status) c = c.where('status', '=', q.status);
      if (q.projectId) c = c.where('projectId', '=', q.projectId);
      const total = Number((await c.select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
      const { skip, take } = toSkipTake(params);
      const items = await this.fetch(trx, { status: q.status, projectId: q.projectId, limit: take, offset: skip });
      return { items, meta: buildPageMeta(params, total) };
    });
  }

  get(actor: RequestActor, id: string): Promise<AgentActionDto> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const [a] = await this.fetch(trx, { ids: [id] });
      if (!a) throw new AppError('NOT_FOUND');
      return a;
    });
  }

  // ------------------------------------------------------------------ deciding

  /** Records the decision. Approving then executes immediately, under the approver's authority. */
  async approve(actor: RequestActor, id: string, note?: string): Promise<AgentActionDto> {
    const expired = await this.dbs.run(this.ctx(actor), async (trx) => {
      const a = await trx.selectFrom('agentActions').select(['status', 'workspaceId', 'projectId', 'expiresAt']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!a) throw new AppError('NOT_FOUND');
      if (a.status !== 'PENDING') throw new AppError('CONFLICT', `This action is already ${a.status.toLowerCase()}.`);
      if (a.expiresAt.getTime() < Date.now()) {
        await trx.updateTable('agentActions').set({ status: 'EXPIRED', updatedAt: new Date() }).where('id', '=', id).execute();
        return true;
      }
      await trx.updateTable('agentActions').set({ status: 'APPROVED', decidedBy: actor.userId, decidedAt: new Date(), decisionNote: note ?? null, updatedAt: new Date() }).where('id', '=', id).execute();
      await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: a.workspaceId, action: 'agent_action.approved', targetType: 'agent_action', targetId: id, metadata: { note: note ?? null } }));
      await this.outbox.enqueue(trx, 'agent.action.approved.v1', { organizationId: actor.orgId, workspaceId: a.workspaceId, projectId: a.projectId, agentActionId: id, actorUserId: actor.userId }, { orgId: actor.orgId, workspaceId: a.workspaceId });
      return false;
    });
    if (expired) throw new AppError('CONFLICT', 'This proposal has expired. Ask the agent to propose it again.');
    return this.execute(actor, id);
  }

  reject(actor: RequestActor, id: string, note?: string): Promise<AgentActionDto> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const a = await trx.selectFrom('agentActions').select(['status', 'workspaceId', 'projectId']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!a) throw new AppError('NOT_FOUND');
      if (a.status !== 'PENDING') throw new AppError('CONFLICT', `This action is already ${a.status.toLowerCase()}.`);
      await trx.updateTable('agentActions').set({ status: 'REJECTED', decidedBy: actor.userId, decidedAt: new Date(), decisionNote: note ?? null, updatedAt: new Date() }).where('id', '=', id).execute();
      await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: a.workspaceId, action: 'agent_action.rejected', targetType: 'agent_action', targetId: id, metadata: { note: note ?? null } }));
      await this.outbox.enqueue(trx, 'agent.action.rejected.v1', { organizationId: actor.orgId, workspaceId: a.workspaceId, projectId: a.projectId, agentActionId: id, actorUserId: actor.userId }, { orgId: actor.orgId, workspaceId: a.workspaceId });
      const [r] = await this.fetch(trx, { ids: [id] });
      return r!;
    });
  }

  /** Re-run an action whose execution failed (transient errors); it is revalidated from scratch. */
  async retry(actor: RequestActor, id: string): Promise<AgentActionDto> {
    return this.execute(actor, id);
  }

  // ------------------------------------------------------------------ executing

  /**
   * Exactly-once execution. Inside ONE transaction: lock the row, claim it (APPROVED|FAILED -> EXECUTING), re-check
   * everything against current state, apply the change through the normal task rules, and mark EXECUTED. If anything
   * throws the whole transaction (including the change) rolls back and the action is recorded as FAILED.
   */
  private async execute(actor: RequestActor, id: string): Promise<AgentActionDto> {
    let applying = false; // true only while the change itself is being applied
    try {
      return await this.dbs.run(this.ctx(actor), async (trx) => {
        const a = await trx.selectFrom('agentActions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!a) throw new AppError('NOT_FOUND');
        if (a.status !== 'APPROVED' && a.status !== 'FAILED') throw new AppError('CONFLICT', `This action is ${a.status.toLowerCase()} and cannot be executed.`);
        if (a.status === 'FAILED' && a.attempts >= MAX_ATTEMPTS) throw new AppError('CONFLICT', 'This action failed too many times. Ask the agent to propose it again.');
        // authority is re-checked NOW, for the person executing, not whoever proposed it
        if (!hasPermission(actor.role, 'approval:decide') || !hasPermission(actor.role, NEEDED[a.actionType])) throw new AppError('FORBIDDEN', 'You do not have permission to apply this change.');

        await trx.updateTable('agentActions').set({ status: 'EXECUTING', attempts: a.attempts + 1, updatedAt: new Date() }).where('id', '=', id).execute();
        const finish = async (status: 'EXECUTED' | 'STALE' | 'FAILED', reason: string | null) => {
          await trx.updateTable('agentActions').set({ status, lastError: reason, executedAt: status === 'EXECUTED' ? new Date() : null, updatedAt: new Date() }).where('id', '=', id).execute();
          await this.audit.record(trx, this.audit.forActor(actor, {
            workspaceId: a.workspaceId, action: `agent_action.${status.toLowerCase()}`, targetType: 'agent_action', targetId: id,
            metadata: { approvalId: id, actionType: a.actionType, targetTaskId: a.targetTaskId, proposedBy: a.proposedBy, payload: a.payload, reason },
          }));
          await this.outbox.enqueue(trx, 'agent.action.completed.v1', { organizationId: actor.orgId, workspaceId: a.workspaceId, projectId: a.projectId, agentActionId: id, actorUserId: actor.userId, status }, { orgId: actor.orgId, workspaceId: a.workspaceId });
          const [r] = await this.fetch(trx, { ids: [id] });
          return r!;
        };

        // 1. the approval is bound to the exact payload: recompute and compare
        if (actionHash({ actionType: a.actionType, targetTaskId: a.targetTaskId, payload: a.payload }) !== a.payloadHash) return finish('FAILED', 'Stored payload does not match its approval hash.');
        // 2. the target must still be what the agent looked at
        const cur = await trx.selectFrom('tasks').select([sql<string>`updated_at::text`.as('version'), 'status', 'deletedAt']).where('id', '=', a.targetTaskId).executeTakeFirst();
        if (!cur || cur.deletedAt) return finish('STALE', 'The task no longer exists or is not accessible.');
        if (cur.version !== a.targetVersion) return finish('STALE', 'The task changed after this was proposed. Review it and ask the agent to propose again.');
        if (isFinished(cur.status)) return finish('STALE', 'The task is already finished.');

        // 3. apply through the same service (and rules) a person's edit would use
        const p = a.payload as { dueDate?: string; assigneeId?: string };
        applying = true;
        await this.tasks.updateInTx(trx, actor, a.targetTaskId, a.actionType === 'TASK_UPDATE_DUE' ? { dueDate: p.dueDate } : { assigneeId: p.assigneeId });
        return finish('EXECUTED', null);
      });
    } catch (e) {
      // guard failures (not found, wrong state, no permission) propagate untouched; a failure while applying is recorded
      if (!applying) throw e;
      return this.markFailed(actor, id, e instanceof AppError ? e.message : 'The change could not be applied.');
    }
  }

  private markFailed(actor: RequestActor, id: string, reason: string): Promise<AgentActionDto> {
    return this.dbs.run(this.ctx(actor), async (trx) => {
      const a = await trx.selectFrom('agentActions').select(['status', 'attempts', 'workspaceId', 'projectId', 'actionType', 'targetTaskId']).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (a.status === 'APPROVED' || a.status === 'FAILED') {
        await trx.updateTable('agentActions').set({ status: 'EXECUTING', attempts: a.attempts + 1, updatedAt: new Date() }).where('id', '=', id).execute();
        await trx.updateTable('agentActions').set({ status: 'FAILED', lastError: reason.slice(0, 500), updatedAt: new Date() }).where('id', '=', id).execute();
        await this.audit.record(trx, this.audit.forActor(actor, { workspaceId: a.workspaceId, action: 'agent_action.failed', targetType: 'agent_action', targetId: id, metadata: { approvalId: id, reason: reason.slice(0, 500) } }));
        await this.outbox.enqueue(trx, 'agent.action.completed.v1', { organizationId: actor.orgId, workspaceId: a.workspaceId, projectId: a.projectId, agentActionId: id, actorUserId: actor.userId, status: 'FAILED' }, { orgId: actor.orgId, workspaceId: a.workspaceId });
      }
      const [r] = await this.fetch(trx, { ids: [id] });
      return r!;
    });
  }
}
