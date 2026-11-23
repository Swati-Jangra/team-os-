import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, sql, withContext, type TestDatabase } from './index';

let t: TestDatabase;
const f = {} as Record<string, string>;
const HASH = 'a'.repeat(64);

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const mkUser = async (e: string) => (await a.insertInto('users').values({ email: e, name: e, passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.owner = await mkUser('o@a.com'); f.dev1 = await mkUser('d1@a.com'); f.dev2 = await mkUser('d2@a.com'); f.out = await mkUser('x@a.com');
  const mkOrg = async (n: string, o: string) => (await a.insertInto('organizations').values({ name: n, slug: n, createdBy: o }).returning('id').executeTakeFirstOrThrow()).id;
  f.org1 = await mkOrg('a1', f.owner); f.org2 = await mkOrg('a2', f.out);
  await a.insertInto('organizationMembers').values([
    { organizationId: f.org1, userId: f.owner, role: 'OWNER' }, { organizationId: f.org1, userId: f.dev1, role: 'DEVELOPER' },
    { organizationId: f.org1, userId: f.dev2, role: 'DEVELOPER' }, { organizationId: f.org2, userId: f.out, role: 'OWNER' },
  ]).execute();
  const mkWs = async (n: string) => (await a.insertInto('workspaces').values({ organizationId: f.org1, name: n, slug: n }).returning('id').executeTakeFirstOrThrow()).id;
  f.ws1 = await mkWs('w1'); f.ws2 = await mkWs('w2');
  await a.insertInto('workspaceMembers').values([
    { organizationId: f.org1, workspaceId: f.ws1, userId: f.dev1, role: 'DEVELOPER' }, { organizationId: f.org1, workspaceId: f.ws2, userId: f.dev2, role: 'DEVELOPER' },
  ]).execute();
  const mkProj = async (ws: string, key: string) => (await a.insertInto('projects').values({ organizationId: f.org1, workspaceId: ws, key, name: key, createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.p1 = await mkProj(f.ws1, 'AA'); f.p2 = await mkProj(f.ws2, 'BB');
  const mkTask = async (ws: string, p: string, n: number) => (await a.insertInto('tasks').values({ organizationId: f.org1, workspaceId: ws, projectId: p, number: n, title: `t${n}`, reporterId: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.t1 = await mkTask(f.ws1, f.p1, 1); f.t2 = await mkTask(f.ws2, f.p2, 1); f.t3 = await mkTask(f.ws1, f.p1, 2);
}, 60_000);
afterAll(async () => t?.destroy());

const action = (extra: object = {}) => ({
  organizationId: f.org1, workspaceId: f.ws1, projectId: f.p1, agent: 'DEPENDENCY_RISK' as const, actionType: 'TASK_UPDATE_DUE' as const,
  targetTaskId: f.t1, targetVersion: '2026-11-18 10:00:00.123456+00', payload: JSON.stringify({ dueDate: '2026-12-01' }), payloadHash: HASH,
  beforeState: JSON.stringify({ dueDate: '2026-11-20' }), afterState: JSON.stringify({ dueDate: '2026-12-01' }), rationale: 'blocked by late work',
  proposedBy: f.dev1, expiresAt: new Date(Date.now() + 86_400_000), ...extra,
});

describe('agent_actions', () => {
  it('follows workspace visibility and refuses cross-workspace / cross-tenant writes', async () => {
    const id = (await withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) => trx.insertInto('agentActions').values(action()).returning('id').executeTakeFirstOrThrow())).id;
    const ids = (c: { userId: string; orgId: string }) => withContext(t.db, c, (trx) => trx.selectFrom('agentActions').select('id').execute()).then((r) => r.map((x) => x.id));
    expect(await ids({ userId: f.dev1, orgId: f.org1 })).toContain(id);
    expect(await ids({ userId: f.dev2, orgId: f.org1 })).not.toContain(id);
    expect(await ids({ userId: f.owner, orgId: f.org1 })).toContain(id);
    expect(await ids({ userId: f.out, orgId: f.org2 })).toEqual([]);
    expect(await ids({ userId: f.out, orgId: f.org1 })).toEqual([]);
    await expect(withContext(t.db, { userId: f.dev2, orgId: f.org1 }, (trx) => trx.insertInto('agentActions').values(action({ targetTaskId: f.t3 })).execute())).rejects.toThrow(/row-level security/);
    // target task must belong to the same workspace as the action
    await expect(t.admin.insertInto('agentActions').values(action({ targetTaskId: f.t2 })).execute()).rejects.toThrow(/foreign key/);
  });

  it('allows only one PENDING proposal per task and kind', async () => {
    await expect(t.admin.insertInto('agentActions').values(action()).execute()).rejects.toThrow(/duplicate key/);
    await t.admin.insertInto('agentActions').values(action({ actionType: 'TASK_ASSIGN', agent: 'TASK_MANAGEMENT' })).execute();
  });

  it('what was proposed can never be edited, and records cannot be deleted', async () => {
    const r = await t.admin.selectFrom('agentActions').select('id').where('actionType', '=', 'TASK_UPDATE_DUE').executeTakeFirstOrThrow();
    for (const patch of [{ payload: JSON.stringify({ dueDate: '2030-01-01' }) }, { payloadHash: 'b'.repeat(64) }, { targetVersion: 'x' }, { targetTaskId: f.t3 }, { afterState: JSON.stringify({}) }]) {
      await expect(t.admin.updateTable('agentActions').set(patch as never).where('id', '=', r.id).execute()).rejects.toThrow(/cannot be modified/);
    }
    await expect(t.admin.deleteFrom('agentActions').where('id', '=', r.id).execute()).rejects.toThrow(/cannot be deleted/);
  });

  it('enforces the state machine: rejected never runs, executed never runs twice', async () => {
    const mk = async (task: string) => (await t.admin.insertInto('agentActions').values(action({ targetTaskId: task, actionType: 'TASK_ASSIGN', agent: 'TASK_MANAGEMENT', status: 'PENDING' })).returning('id').executeTakeFirstOrThrow()).id;
    const set = (id: string, status: string) => t.admin.updateTable('agentActions').set({ status } as never).where('id', '=', id).execute();
    const rejected = await mk(f.t3);
    await set(rejected, 'REJECTED');
    for (const s of ['APPROVED', 'EXECUTING', 'EXECUTED', 'PENDING']) await expect(set(rejected, s)).rejects.toThrow(/illegal agent action transition/);
  });

  it('happy path and retry path are allowed, terminal states are final', async () => {
    const id = (await t.admin.insertInto('agentActions').values(action({ targetTaskId: f.t3 })).returning('id').executeTakeFirstOrThrow()).id;
    await expect(t.admin.updateTable('agentActions').set({ status: 'EXECUTING' }).where('id', '=', id).execute()).rejects.toThrow(/illegal/); // not approved yet
    const set = (s: string) => t.admin.updateTable('agentActions').set({ status: s } as never).where('id', '=', id).execute();
    await set('APPROVED'); await set('EXECUTING'); await set('FAILED'); await set('EXECUTING'); await set('EXECUTED');
    for (const s of ['EXECUTING', 'APPROVED', 'FAILED', 'REJECTED']) await expect(set(s)).rejects.toThrow(/illegal/);
  });

  it('expiry sweep only expires overdue PENDING actions', async () => {
    const mk = async (expiresAt: Date) => (await t.admin.insertInto('agentActions').values(action({ targetTaskId: f.t3, actionType: 'TASK_ASSIGN', agent: 'TASK_MANAGEMENT', expiresAt })).returning('id').executeTakeFirstOrThrow()).id;
    // the earlier tests left t3/TASK_ASSIGN free of PENDING rows only if they were decided; make room deterministically
    await t.admin.updateTable('agentActions').set({ status: 'REJECTED' } as never).where('targetTaskId', '=', f.t3).where('status', '=', 'PENDING').execute();
    const overdue = await mk(new Date(Date.now() - 60_000));
    const future = await t.admin.insertInto('agentActions').values(action({ targetTaskId: f.t3, actionType: 'TASK_UPDATE_DUE' })).returning('id').executeTakeFirstOrThrow().then((r) => r.id);
    const n = await withContext(t.db, {}, async (trx) => (await sql<{ n: number }>`SELECT job_expire_agent_actions(${new Date().toISOString()}::timestamptz) AS n`.execute(trx)).rows[0]!.n);
    expect(Number(n)).toBeGreaterThanOrEqual(1);
    const st = async (id: string) => (await t.admin.selectFrom('agentActions').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
    expect(await st(overdue)).toBe('EXPIRED');
    expect(await st(future)).toBe('PENDING');
  });
});
