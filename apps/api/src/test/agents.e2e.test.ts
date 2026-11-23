import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@teamos/shared';
import { AgentToolbox } from '../modules/agents/agent-tools';
import { DbService } from '../db/db.service';
import { createHarness, type Client, type Harness } from './harness';

let h: Harness;
let owner: Client;
let pm: Client; // PROJECT_MANAGER ws1
let pm2: Client; // PROJECT_MANAGER ws2 only
let dev: Client; // DEVELOPER ws1 (can run agents, cannot decide)
let dev2: Client; // DEVELOPER ws2
let viewer: Client;
let org: string;
let ws1: string;
let ws2: string;
let proj: string;
let proj2: string;
const today = new Date().toISOString().slice(0, 10);
const base = () => `/organizations/${org}`;
const T: Record<string, string> = {};

async function addMember(email: string, role: string, workspaceIds: string[]): Promise<Client> {
  const c = await h.signup(email);
  expect((await owner.post(`${base()}/invitations`, { email, role, workspaceIds })).status).toBe(201);
  expect((await c.post('/invitations/accept', { token: await h.tokenFor('member.invited.v1', email) })).status).toBe(200);
  return c;
}
const mkTask = async (c: Client, p: string, title: string, extra: object = {}) => {
  const r = await c.post(`${base()}/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string };
};
const getTask = async (id: string) => (await owner.get(`${base()}/tasks/${id}`)).body.data as { dueDate: string | null; assigneeId: string | null; updatedAt: string };
const propose = async (c: Client, p = proj, agent?: string) => c.post(`${base()}/projects/${p}/agent-proposals`, agent ? { agent } : {});
const actions = async (c: Client, q = '') => (await c.get(`${base()}/agent-actions${q}`)).body.data as Array<{ id: string; status: string; actionType: string; targetTaskId: string; targetIdentifier: string; before: unknown; after: unknown; lastError: string | null; attempts: number }>;

beforeAll(async () => {
  h = await createHarness();
  owner = await h.signup('owner@g.com', 'Owner');
  org = (await owner.post('/organizations', { name: 'Agent Org' })).body.data.id;
  ws1 = (await owner.post(`${base()}/workspaces`, { name: 'Alpha' })).body.data.id;
  ws2 = (await owner.post(`${base()}/workspaces`, { name: 'Beta' })).body.data.id;
  proj = (await owner.post(`${base()}/projects`, { workspaceId: ws1, name: 'Apollo', key: 'APO', dueDate: addDays(today, 5) })).body.data.id;
  proj2 = (await owner.post(`${base()}/projects`, { workspaceId: ws2, name: 'Beta', key: 'BET' })).body.data.id;
  pm = await addMember('pm@g.com', 'PROJECT_MANAGER', [ws1]);
  pm2 = await addMember('pm2@g.com', 'PROJECT_MANAGER', [ws2]);
  dev = await addMember('dev@g.com', 'DEVELOPER', [ws1]);
  dev2 = await addMember('dev2@g.com', 'DEVELOPER', [ws2]);
  viewer = await addMember('view@g.com', 'VIEWER', [ws1]);
  // A is overdue; B depends on A; C depends on B; D is unassigned and due soon
  T.a = (await mkTask(owner, proj, 'A backend', { dueDate: addDays(today, -5), assigneeId: dev.userId })).id;
  T.b = (await mkTask(owner, proj, 'B integration', { dueDate: addDays(today, 2), assigneeId: dev.userId })).id;
  T.c = (await mkTask(owner, proj, 'C release', { dueDate: addDays(today, 9), assigneeId: dev.userId })).id;
  T.d = (await mkTask(owner, proj, 'D docs', { dueDate: addDays(today, 3) })).id;
  expect((await owner.post(`${base()}/tasks/${T.b}/dependencies`, { dependsOnTaskId: T.a })).status).toBe(201);
  expect((await owner.post(`${base()}/tasks/${T.c}/dependencies`, { dependsOnTaskId: T.b })).status).toBe(201);
  T.other = (await mkTask(owner, proj2, 'Beta task', { dueDate: addDays(today, -3) })).id;
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('risk detection', () => {
  it('separates facts from inferences and respects visibility', async () => {
    const r = await viewer.get(`${base()}/projects/${proj}/risks`); // read-only users can see risks
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const f = r.body.data.projects[0].findings as Array<{ kind: string; basis: string; identifier: string; slipDays?: number }>;
    expect(f.find((x) => x.kind === 'OVERDUE')).toMatchObject({ basis: 'FACT', identifier: 'APO-1', slipDays: 5 });
    expect(f.filter((x) => x.kind === 'BLOCKED_BY_LATE').map((x) => x.identifier).sort()).toEqual(['APO-2', 'APO-3']);
    expect(f.every((x) => (x.kind === 'BLOCKED_BY_LATE' ? x.basis === 'INFERRED' : true))).toBe(true);
    expect(f.some((x) => x.kind === 'UNASSIGNED_DUE_SOON' && x.identifier === 'APO-4')).toBe(true);
    expect(f.some((x) => x.kind === 'PROJECT_DEADLINE')).toBe(true);
    expect((await dev2.get(`${base()}/projects/${proj}/risks`)).status).toBe(404); // other workspace
    const org2 = await dev2.get(`${base()}/risks`);
    expect(org2.body.data.projects.map((p: { key: string }) => p.key)).toEqual(['BET']); // only what dev2 may see
    const all = await owner.get(`${base()}/risks`);
    expect(all.body.data.projects.map((p: { key: string }) => p.key).sort()).toEqual(['APO', 'BET']);
  });
});

describe('agent proposals never change data', () => {
  it('needs ai:use and workspace access; creates PENDING proposals only; is idempotent', async () => {
    expect((await propose(viewer)).status).toBe(403);
    expect((await propose(dev2)).status).toBe(404);
    const before = await Promise.all(['a', 'b', 'c', 'd'].map((k) => getTask(T[k]!)));
    const r = await propose(dev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = r.body.data as Array<{ actionType: string; status: string; targetIdentifier: string; before: { dueDate?: string }; after: { dueDate?: string; assigneeId?: string } }>;
    expect(list.every((x) => x.status === 'PENDING')).toBe(true);
    const due = list.filter((x) => x.actionType === 'TASK_UPDATE_DUE').map((x) => x.targetIdentifier).sort();
    expect(due).toEqual(['APO-2', 'APO-3']); // downstream only; the overdue task itself is not touched
    const b = list.find((x) => x.targetIdentifier === 'APO-2')!;
    expect(b.before.dueDate).toBe(addDays(today, 2));
    expect(b.after.dueDate).toBe(addDays(today, 7)); // +5 days of slip
    expect(list.find((x) => x.actionType === 'TASK_ASSIGN')!.targetIdentifier).toBe('APO-4');
    const after = await Promise.all(['a', 'b', 'c', 'd'].map((k) => getTask(T[k]!)));
    expect(after).toEqual(before); // untouched
    expect((await propose(dev)).body.data).toHaveLength(0); // no duplicates when re-run
    const au = await h.t.admin.selectFrom('auditLogs').select(['actorType', 'action']).where('action', '=', 'agent_action.proposed').execute();
    expect(au.length).toBe(3);
    expect(au.every((a) => a.actorType === 'AI')).toBe(true);
  });

  it('proposals are visible only to people who can see the workspace', async () => {
    expect((await actions(dev)).length).toBe(3);
    expect((await actions(dev2)).length).toBe(0);
    expect((await actions(pm2)).length).toBe(0);
    expect((await actions(viewer)).length).toBe(3);
  });
});

describe('approval workflow', () => {
  it('unauthorized users cannot decide; approver outside the workspace cannot see it', async () => {
    const [x] = await actions(owner, '?status=PENDING');
    expect((await dev.post(`${base()}/agent-actions/${x!.id}/approve`, {})).status).toBe(403);
    expect((await viewer.post(`${base()}/agent-actions/${x!.id}/reject`, {})).status).toBe(403);
    expect((await pm2.post(`${base()}/agent-actions/${x!.id}/approve`, {})).status).toBe(404);
    expect((await pm2.get(`${base()}/agent-actions/${x!.id}`)).status).toBe(404);
    expect((await actions(owner, '?status=PENDING')).length).toBe(3);
  });

  it('approve executes exactly once and is fully audited; rejected actions never execute', async () => {
    const pend = await actions(owner, '?status=PENDING');
    const dueB = pend.find((x) => x.targetIdentifier === 'APO-2')!;
    const dueC = pend.find((x) => x.targetIdentifier === 'APO-3')!;
    const ok = await pm.post(`${base()}/agent-actions/${dueB.id}/approve`, { note: 'agreed in standup' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'EXECUTED', attempts: 1, decisionNote: 'agreed in standup' });
    expect((await getTask(T.b!)).dueDate).toBe(addDays(today, 7));
    // cannot run twice
    expect((await pm.post(`${base()}/agent-actions/${dueB.id}/approve`, {})).status).toBe(409);
    expect((await pm.post(`${base()}/agent-actions/${dueB.id}/retry`, {})).status).toBe(409);
    expect((await pm.post(`${base()}/agent-actions/${dueB.id}/reject`, {})).status).toBe(409);
    // audit: the mutation references the approval and both people
    const au = await h.t.admin.selectFrom('auditLogs').select(['actorId', 'metadata']).where('action', '=', 'agent_action.executed').where('targetId', '=', dueB.id).execute();
    expect(au).toHaveLength(1);
    expect(au[0]!.actorId).toBe(pm.userId);
    expect(au[0]!.metadata).toMatchObject({ approvalId: dueB.id, proposedBy: dev.userId, targetTaskId: T.b });
    // rejected never executes
    const rej = await pm.post(`${base()}/agent-actions/${dueC.id}/reject`, { note: 'no' });
    expect(rej.body.data.status).toBe('REJECTED');
    for (const path of ['approve', 'retry']) expect((await pm.post(`${base()}/agent-actions/${dueC.id}/${path}`, {})).status).toBe(409);
    expect((await getTask(T.c!)).dueDate).toBe(addDays(today, 9));
  });

  it('a changed target invalidates the approval (STALE) and nothing is applied', async () => {
    const assign = (await actions(owner, '?status=PENDING')).find((x) => x.actionType === 'TASK_ASSIGN')!;
    expect((await dev.patch(`${base()}/tasks/${T.d}`, { title: 'D docs (edited)' })).status).toBe(200);
    const r = await pm.post(`${base()}/agent-actions/${assign.id}/approve`, {});
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('STALE');
    expect((await getTask(T.d!)).assigneeId).toBeNull();
    expect((await pm.post(`${base()}/agent-actions/${assign.id}/retry`, {})).status).toBe(409);
  });

  it('expired proposals cannot be approved', async () => {
    const r = await propose(dev, proj, 'TASK_MANAGEMENT'); // D changed, so the agent proposes again against the new version
    const id = r.body.data[0].id as string;
    await withoutGuard(() => sqlRun(`UPDATE agent_actions SET expires_at = now() - interval '1 second' WHERE id = '${id}'`));
    const a = await pm.post(`${base()}/agent-actions/${id}/approve`, {});
    expect(a.status).toBe(409);
    expect((await owner.get(`${base()}/agent-actions/${id}`)).body.data.status).toBe('EXPIRED');
    expect((await getTask(T.d!)).assigneeId).toBeNull();
  });
});

const sqlRun = async (q: string) => {
  const { sql } = await import('@teamos/database');
  await sql.raw(q).execute(h.t.admin);
};
/** Tests need to simulate corruption/time travel that the guard trigger forbids at runtime. */
const withoutGuard = async (fn: () => Promise<unknown>) => {
  await sqlRun('ALTER TABLE agent_actions DISABLE TRIGGER agent_actions_guard_trg');
  try {
    await fn();
  } finally {
    await sqlRun('ALTER TABLE agent_actions ENABLE TRIGGER agent_actions_guard_trg');
  }
};

describe('execution safety', () => {
  let n = 0;
  const freshAssign = async () => {
    const t = await mkTask(owner, proj, `Extra ${++n}`, { dueDate: addDays(today, 4) });
    const r = await propose(dev, proj, 'TASK_MANAGEMENT');
    const mine = (r.body.data as Array<{ id: string; targetTaskId: string; after: { assigneeId: string } }>).find((x) => x.targetTaskId === t.id)!;
    return { task: t.id, action: mine };
  };

  it('a failed execution rolls back, is recorded, and is safely retryable', async () => {
    const { task, action } = await freshAssign();
    const assignee = action.after.assigneeId;
    // the proposed assignee leaves the workspace before approval
    await sqlRun(`UPDATE workspace_members SET deleted_at = now() WHERE user_id = '${assignee}' AND workspace_id = '${ws1}'`);
    const r = await owner.post(`${base()}/agent-actions/${action.id}/approve`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(r.body.data.lastError).toMatch(/member/i);
    expect((await getTask(task)).assigneeId).toBeNull(); // nothing half-applied
    // fix the cause, retry: revalidated from scratch, executes once
    await sqlRun(`UPDATE workspace_members SET deleted_at = NULL WHERE user_id = '${assignee}' AND workspace_id = '${ws1}'`);
    const retry = await owner.post(`${base()}/agent-actions/${action.id}/retry`, {});
    expect(retry.body.data).toMatchObject({ status: 'EXECUTED', attempts: 2 });
    expect((await getTask(task)).assigneeId).toBe(assignee);
    expect((await owner.post(`${base()}/agent-actions/${action.id}/retry`, {})).status).toBe(409);
    expect((await dev.post(`${base()}/agent-actions/${action.id}/retry`, {})).status).toBe(403);
  });

  it('a payload that no longer matches its approval hash is never executed', async () => {
    const { task, action } = await freshAssign();
    await withoutGuard(() => sqlRun(`UPDATE agent_actions SET payload = jsonb_build_object('assigneeId', '${action.after.assigneeId === dev.userId ? pm.userId : dev.userId}') WHERE id = '${action.id}'`));
    const r = await owner.post(`${base()}/agent-actions/${action.id}/approve`, {});
    expect(r.body.data.status).toBe('FAILED');
    expect(r.body.data.lastError).toMatch(/hash/i);
    expect((await getTask(task)).assigneeId).toBeNull();
  });

  it('concurrent approvals apply the change exactly once', async () => {
    const { task, action } = await freshAssign();
    const rs = await Promise.all([1, 2, 3].map(() => owner.post(`${base()}/agent-actions/${action.id}/approve`, {})));
    expect(rs.filter((r) => r.status === 200 && r.body.data.status === 'EXECUTED')).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    const execs = await h.t.admin.selectFrom('auditLogs').select('id').where('action', '=', 'agent_action.executed').where('targetId', '=', action.id).execute();
    expect(execs).toHaveLength(1);
    expect((await getTask(task)).assigneeId).toBe(action.after.assigneeId);
  });

  it('the database refuses edits to proposals and illegal state changes', async () => {
    const [x] = await actions(owner, '?status=EXECUTED');
    await expect(sqlRun(`UPDATE agent_actions SET payload = '{}'::jsonb WHERE id = '${x!.id}'`)).rejects.toThrow();
    await expect(sqlRun(`UPDATE agent_actions SET status = 'EXECUTING' WHERE id = '${x!.id}'`)).rejects.toThrow();
  });
});

describe('agent tool authorization', () => {
  const actor = (role: string, userId: string) => ({ userId, orgId: org, role, requestId: 'r', ip: null }) as never;
  it('tools require permissions, run under the user’s own visibility, and cannot cross tenants', async () => {
    // role without project/task read cannot use the tool at all
    const dbService = h.app.get(DbService);
    await expect(new AgentToolbox(dbService, actor('GUEST', dev.userId)).workspaceAssignees(ws1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // a real member of ws2 asking for ws1's project: not found, not empty-success
    await expect(new AgentToolbox(dbService, actor('DEVELOPER', dev2.userId)).projectSnapshots({ projectId: proj })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // another org's id cannot be smuggled in through the actor: RLS gives nothing
    const other = await h.signup('stranger@g.com');
    const otherOrg = (await other.post('/organizations', { name: 'Other' })).body.data.id;
    const snaps = await new AgentToolbox(dbService, { ...(actor('OWNER', other.userId) as object), orgId: otherOrg } as never).projectSnapshots({ workspaceId: ws1 });
    expect(snaps).toEqual([]);
    // assignee candidates are workspace members who may be assigned work (no viewers)
    const people = await new AgentToolbox(dbService, actor('OWNER', owner.userId)).workspaceAssignees(ws1);
    expect(people.map((p) => p.userId)).toEqual(expect.arrayContaining([dev.userId, pm.userId]));
    expect(people.map((p) => p.userId)).not.toContain(viewer.userId);
  });
});
