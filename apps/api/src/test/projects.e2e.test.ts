import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Client, type Harness } from './harness';

let h: Harness;
let owner: Client;
let pm: Client; // PROJECT_MANAGER, ws1 only
let lead: Client; // TEAM_LEAD, ws1
let dev: Client; // DEVELOPER, ws1
let devOnly2: Client; // DEVELOPER, ws2 only
let viewer: Client; // VIEWER, ws1
let outsider: Client; // owner of another org
let org: string;
let ws1: string;
let ws2: string;
let P: string; // project in ws1
const base = () => `/organizations/${org}`;

async function addMember(email: string, role: string, workspaceIds: string[]): Promise<Client> {
  const c = await h.signup(email);
  expect((await owner.post(`${base()}/invitations`, { email, role, workspaceIds })).status).toBe(201);
  const token = await h.tokenFor('member.invited.v1', email);
  expect((await c.post('/invitations/accept', { token })).status).toBe(200);
  return c;
}

beforeAll(async () => {
  h = await createHarness();
  owner = await h.signup('owner@p.com', 'Owner');
  outsider = await h.signup('out@q.com', 'Outsider');
  org = (await owner.post('/organizations', { name: 'Proj Org' })).body.data.id;
  await outsider.post('/organizations', { name: 'Other Org' });
  ws1 = (await owner.post(`${base()}/workspaces`, { name: 'Alpha' })).body.data.id;
  ws2 = (await owner.post(`${base()}/workspaces`, { name: 'Beta' })).body.data.id;
  pm = await addMember('pm@p.com', 'PROJECT_MANAGER', [ws1]);
  lead = await addMember('lead@p.com', 'TEAM_LEAD', [ws1]);
  dev = await addMember('dev@p.com', 'DEVELOPER', [ws1]);
  devOnly2 = await addMember('dev2@p.com', 'DEVELOPER', [ws2]);
  viewer = await addMember('view@p.com', 'VIEWER', [ws1]);
  const p = await pm.post(`${base()}/projects`, { workspaceId: ws1, name: 'Platform Engineering' });
  expect(p.status).toBe(201);
  P = p.body.data.id;
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const mkTask = async (c: Client, title: string, extra: object = {}, project = P) => {
  const r = await c.post(`${base()}/projects/${project}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; number: number; identifier: string; status: string };
};

describe('projects', () => {
  it('derives a key, enforces uniqueness and permissions', async () => {
    const r = await pm.get(`${base()}/projects/${P}`);
    expect(r.body.data.key).toBe('PE');
    expect(r.body.data.status).toBe('PLANNING');

    const dup = await pm.post(`${base()}/projects`, { workspaceId: ws1, name: 'Other', key: 'pe' });
    expect(dup.status).toBe(409);

    // auto-derived collisions get a suffix instead of failing
    const second = await pm.post(`${base()}/projects`, { workspaceId: ws1, name: 'Product Experience' });
    expect(second.status).toBe(201);
    expect(second.body.data.key).not.toBe('PE');

    expect((await dev.post(`${base()}/projects`, { workspaceId: ws1, name: 'Nope' })).status).toBe(403);
    expect((await viewer.post(`${base()}/projects`, { workspaceId: ws1, name: 'Nope' })).status).toBe(403);
  });

  it('validates input', async () => {
    const bad = await pm.post(`${base()}/projects`, { workspaceId: ws1, name: 'Dates', startDate: '2026-05-10', dueDate: '2026-05-01' });
    expect(bad.status).toBe(400);
    expect((await pm.post(`${base()}/projects`, { workspaceId: ws1, name: 'x', key: '1bad' })).status).toBe(400);
    expect((await pm.patch(`${base()}/projects/${P}`, {})).status).toBe(400);
    // partial update is cross-checked against stored dates
    await pm.patch(`${base()}/projects/${P}`, { startDate: '2026-06-01', dueDate: '2026-06-30' });
    expect((await pm.patch(`${base()}/projects/${P}`, { dueDate: '2026-05-01' })).status).toBe(400);
    const ok = await pm.patch(`${base()}/projects/${P}`, { status: 'ACTIVE' });
    expect(ok.body.data.status).toBe('ACTIVE');
    expect(ok.body.data.startDate).toBe('2026-06-01'); // dates round-trip as plain strings
  });

  it('only shows projects in workspaces the caller belongs to', async () => {
    const p2 = await owner.post(`${base()}/projects`, { workspaceId: ws2, name: 'Beta Project' });
    expect(p2.status).toBe(201);
    const id2 = p2.body.data.id;

    const devList = await dev.get(`${base()}/projects`);
    expect(devList.body.data.map((p: { id: string }) => p.id)).not.toContain(id2);
    expect((await dev.get(`${base()}/projects/${id2}`)).status).toBe(404);
    expect((await dev.get(`${base()}/projects/${id2}/tasks`)).status).toBe(404);
    expect((await dev.post(`${base()}/projects/${id2}/tasks`, { title: 'sneaky' })).status).toBe(404);
    expect((await dev.post(`${base()}/projects`, { workspaceId: ws2, name: 'x' })).status).toBe(403); // no permission anyway
    expect((await pm.post(`${base()}/projects`, { workspaceId: ws2, name: 'Beta Hack' })).status).toBe(404); // pm not in ws2

    const ownerList = await owner.get(`${base()}/projects`);
    expect(ownerList.body.data.map((p: { id: string }) => p.id)).toContain(id2);
    const filtered = await owner.get(`${base()}/projects?workspaceId=${ws2}`);
    expect(filtered.body.data.every((p: { workspaceId: string }) => p.workspaceId === ws2)).toBe(true);
  });

  it('is invisible to other organizations', async () => {
    expect((await outsider.get(`${base()}/projects`)).status).toBe(404);
    expect((await outsider.get(`${base()}/projects/${P}`)).status).toBe(404);
  });
});

describe('tasks', () => {
  it('numbers tasks per project, even under concurrency', async () => {
    const proj = (await pm.post(`${base()}/projects`, { workspaceId: ws1, name: 'Concurrency Lab', key: 'CON' })).body.data.id;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => dev.post(`${base()}/projects/${proj}/tasks`, { title: `t${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.data.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(results[0]!.body.data.identifier).toMatch(/^CON-\d+$/);
  });

  it('enforces create/update permissions by role', async () => {
    const t = await mkTask(dev, 'Developer task');
    expect((await viewer.post(`${base()}/projects/${P}/tasks`, { title: 'no' })).status).toBe(403);
    expect((await viewer.patch(`${base()}/tasks/${t.id}`, { title: 'no' })).status).toBe(403);
    expect((await viewer.get(`${base()}/tasks/${t.id}`)).status).toBe(200);
    expect((await dev.delete(`${base()}/tasks/${t.id}`)).status).toBe(403);
    expect((await lead.delete(`${base()}/tasks/${(await mkTask(dev, 'to delete')).id}`)).status).toBe(200);
  });

  it('assignment rules: self-assign ok, assigning others needs task:assign, assignee must be in the workspace', async () => {
    const t = await mkTask(dev, 'Assign me');
    const me = await dev.get('/auth/me');
    const devId: string = me.body.data.user.id;
    const leadId: string = (await lead.get('/auth/me')).body.data.user.id;
    const dev2Id: string = (await devOnly2.get('/auth/me')).body.data.user.id;

    expect((await dev.patch(`${base()}/tasks/${t.id}`, { assigneeId: devId })).status).toBe(200);
    expect((await dev.patch(`${base()}/tasks/${t.id}`, { assigneeId: leadId })).status).toBe(403);
    expect((await lead.patch(`${base()}/tasks/${t.id}`, { assigneeId: leadId })).body.data.assigneeName).toBeTruthy();
    // dev2 is not a member of ws1
    const bad = await lead.patch(`${base()}/tasks/${t.id}`, { assigneeId: dev2Id });
    expect(bad.status).toBe(400);
    // owner/admin are assignable anywhere in the org
    const ownerId = (await owner.get('/auth/me')).body.data.user.id;
    expect((await lead.patch(`${base()}/tasks/${t.id}`, { assigneeId: ownerId })).status).toBe(200);
  });

  it('status transitions, completedAt, and filtering', async () => {
    const t = await mkTask(dev, 'Status task', { priority: 'HIGH', labels: ['api', 'p1'] });
    expect(t.status).toBe('TODO');
    const done = await dev.patch(`${base()}/tasks/${t.id}`, { status: 'DONE' });
    expect(done.body.data.completedAt).not.toBeNull();
    const reopen = await dev.patch(`${base()}/tasks/${t.id}`, { status: 'IN_PROGRESS' });
    expect(reopen.body.data.completedAt).toBeNull();

    const f = await dev.get(`${base()}/projects/${P}/tasks?status=IN_PROGRESS&q=status`);
    expect(f.body.data.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect(f.body.data[0].labels).toEqual(['api', 'p1']);
    // wildcard characters in search are literals
    expect((await dev.get(`${base()}/projects/${P}/tasks?q=%25`)).body.data).toHaveLength(0);
    expect((await dev.get(`${base()}/projects/${P}/tasks?status=NOPE`)).status).toBe(400);
  });

  it('caps a project task listing and reports the real total in meta', async () => {
    const big = (await pm.post(`${base()}/projects`, { workspaceId: ws1, name: 'Huge backlog', key: 'HUG' })).body.data.id as string;
    const ws = (await h.t.admin.selectFrom('projects').select(['organizationId', 'workspaceId']).where('id', '=', big).executeTakeFirstOrThrow());
    const reporter = (await h.t.admin.selectFrom('users').select('id').where('email', '=', 'owner@p.com').executeTakeFirstOrThrow()).id;
    const rows = Array.from({ length: 2005 }, (_, i) => ({ organizationId: ws.organizationId, workspaceId: ws.workspaceId, projectId: big, number: i + 1, title: `bulk ${i}`, reporterId: reporter, position: i }));
    for (let i = 0; i < rows.length; i += 500) await h.t.admin.insertInto('tasks').values(rows.slice(i, i + 500)).execute();
    await h.t.admin.updateTable('projects').set({ taskSeq: 2005 }).where('id', '=', big).execute(); // keep the counter consistent with the seeded rows
    const r = await dev.get(`${base()}/projects/${big}/tasks`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2000);
    expect(r.body.meta.total).toBe(2005);
    expect(r.body.data[0].title).toBe('bulk 0'); // stable order: position, then number
    // a normal-sized listing reports its own size
    const small = await dev.get(`${base()}/projects/${P}/tasks`);
    expect(small.body.meta.total).toBe(small.body.data.length);
    // creating in a big project still appends after the last task of its column
    const created = await mkTask(dev, 'appended', {}, big);
    expect(created.position).toBeGreaterThan(2004);
  });

  it('rejects malformed input', async () => {
    expect((await dev.post(`${base()}/projects/${P}/tasks`, { title: '' })).status).toBe(400);
    expect((await dev.post(`${base()}/projects/${P}/tasks`, { title: 'x', dueDate: '2026-02-30x' })).status).toBe(400);
    expect((await dev.post(`${base()}/projects/${P}/tasks`, { title: 'x', startDate: '2026-03-02', dueDate: '2026-03-01' })).status).toBe(400);
    expect((await dev.get(`${base()}/tasks/not-a-uuid`)).status).toBe(400);
    expect((await dev.patch(`${base()}/tasks/${(await mkTask(dev, 'v')).id}`, { status: 'WHATEVER' })).status).toBe(400);
  });

  it('lists my tasks across projects and excludes finished ones', async () => {
    const meId = (await dev.get('/auth/me')).body.data.user.id;
    const a = await mkTask(dev, 'mine open', { assigneeId: meId, dueDate: '2026-12-01' });
    const b = await mkTask(dev, 'mine done', { assigneeId: meId, status: 'DONE' });
    const mine = await dev.get(`${base()}/tasks/mine`);
    expect(mine.status).toBe(200);
    const ids = mine.body.data.map((x: { id: string }) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});

describe('dependencies', () => {
  it('blocks completion until blockers are done, and rejects cycles', async () => {
    const a = await mkTask(dev, 'dep A');
    const b = await mkTask(dev, 'dep B');
    const c = await mkTask(dev, 'dep C');

    // B depends on A, C depends on B
    expect((await dev.post(`${base()}/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id })).status).toBe(201);
    expect((await dev.post(`${base()}/tasks/${c.id}/dependencies`, { dependsOnTaskId: b.id })).status).toBe(201);
    // idempotent
    expect((await dev.post(`${base()}/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id })).status).toBe(201);

    // cycles: direct and transitive
    expect((await dev.post(`${base()}/tasks/${a.id}/dependencies`, { dependsOnTaskId: b.id })).status).toBe(409);
    const trans = await dev.post(`${base()}/tasks/${a.id}/dependencies`, { dependsOnTaskId: c.id });
    expect(trans.status).toBe(409);
    expect(trans.body.error.message).toMatch(/cycle/i);
    expect((await dev.post(`${base()}/tasks/${a.id}/dependencies`, { dependsOnTaskId: a.id })).status).toBe(400);

    const detail = await dev.get(`${base()}/tasks/${b.id}`);
    expect(detail.body.data.blockedBy.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(detail.body.data.blocks.map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect(detail.body.data.openBlockers).toBe(1);

    const blocked = await dev.patch(`${base()}/tasks/${b.id}`, { status: 'DONE' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.blockers).toHaveLength(1);

    expect((await dev.patch(`${base()}/tasks/${a.id}`, { status: 'DONE' })).status).toBe(200);
    expect((await dev.patch(`${base()}/tasks/${b.id}`, { status: 'DONE' })).status).toBe(200);

    expect((await dev.delete(`${base()}/tasks/${c.id}/dependencies/${b.id}`)).status).toBe(200);
    expect((await dev.delete(`${base()}/tasks/${c.id}/dependencies/${b.id}`)).status).toBe(404);
  });

  it('concurrent opposite edges cannot form a cycle', async () => {
    const a = await mkTask(dev, 'race A');
    const b = await mkTask(dev, 'race B');
    const [r1, r2] = await Promise.all([
      dev.post(`${base()}/tasks/${a.id}/dependencies`, { dependsOnTaskId: b.id }),
      dev.post(`${base()}/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
  });

  it('refuses cross-workspace and invisible tasks', async () => {
    const own = await mkTask(dev, 'ws1 task');
    const p2 = (await owner.post(`${base()}/projects`, { workspaceId: ws2, name: 'Gamma Two' })).body.data.id;
    const foreign = await mkTask(owner, 'ws2 task', {}, p2);
    // dev cannot even see the ws2 task
    expect((await dev.post(`${base()}/tasks/${own.id}/dependencies`, { dependsOnTaskId: foreign.id })).status).toBe(404);
    // owner sees both but they live in different workspaces
    expect((await owner.post(`${base()}/tasks/${own.id}/dependencies`, { dependsOnTaskId: foreign.id })).status).toBe(400);
  });

  it('deleting a task removes its edges', async () => {
    const a = await mkTask(dev, 'del A');
    const b = await mkTask(dev, 'del B');
    await dev.post(`${base()}/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id });
    expect((await lead.delete(`${base()}/tasks/${a.id}`)).status).toBe(200);
    const detail = await dev.get(`${base()}/tasks/${b.id}`);
    expect(detail.body.data.blockedBy).toEqual([]);
    expect(detail.body.data.openBlockers).toBe(0);
    expect((await dev.get(`${base()}/tasks/${a.id}`)).status).toBe(404);
  });
});

describe('milestones', () => {
  it('creates, links tasks, rejects foreign-project milestones, and detaches on delete', async () => {
    expect((await dev.post(`${base()}/projects/${P}/milestones`, { name: 'No' })).status).toBe(403);
    const m = await lead.post(`${base()}/projects/${P}/milestones`, { name: 'Beta release', dueDate: '2026-09-01' });
    expect(m.status).toBe(201);
    const mid = m.body.data.id;

    const t = await mkTask(dev, 'In milestone', { milestoneId: mid });
    const done = await mkTask(dev, 'Done in milestone', { milestoneId: mid, status: 'DONE' });
    const list = await dev.get(`${base()}/projects/${P}/milestones`);
    const row = list.body.data.find((x: { id: string }) => x.id === mid);
    expect(row.taskCount).toBe(2);
    expect(row.doneCount).toBe(1);

    const other = (await pm.post(`${base()}/projects`, { workspaceId: ws1, name: 'Sibling', key: 'SIB' })).body.data.id;
    const bad = await dev.post(`${base()}/projects/${other}/tasks`, { title: 'wrong', milestoneId: mid });
    expect(bad.status).toBe(400);

    expect((await lead.patch(`${base()}/milestones/${mid}`, { status: 'COMPLETED' })).body.data.status).toBe('COMPLETED');
    expect((await lead.delete(`${base()}/milestones/${mid}`)).status).toBe(200);
    expect((await dev.get(`${base()}/tasks/${t.id}`)).body.data.milestoneId).toBeNull();
    expect((await dev.get(`${base()}/tasks/${done.id}`)).status).toBe(200);
  });
});

describe('comments & activity', () => {
  it('enforces author-only edits and moderation on delete', async () => {
    const t = await mkTask(dev, 'Discuss me');
    expect((await viewer.post(`${base()}/tasks/${t.id}/comments`, { body: 'hi' })).status).toBe(403);
    expect((await dev.post(`${base()}/tasks/${t.id}/comments`, { body: '   ' })).status).toBe(400);

    const c = await dev.post(`${base()}/tasks/${t.id}/comments`, { body: 'First!' });
    expect(c.status).toBe(201);
    expect(c.body.data.authorName).toBeTruthy();
    const cid = c.body.data.id;

    expect((await lead.patch(`${base()}/comments/${cid}`, { body: 'edit' })).status).toBe(403);
    const edited = await dev.patch(`${base()}/comments/${cid}`, { body: 'First! (edited)' });
    expect(edited.body.data.editedAt).not.toBeNull();

    expect((await viewer.get(`${base()}/tasks/${t.id}/comments`)).body.data).toHaveLength(1);
    expect((await devOnly2.get(`${base()}/tasks/${t.id}/comments`)).status).toBe(404);
    expect((await devOnly2.delete(`${base()}/comments/${cid}`)).status).toBe(404);

    expect((await lead.delete(`${base()}/comments/${cid}`)).status).toBe(200); // lead has task:delete
    expect((await dev.get(`${base()}/tasks/${t.id}/comments`)).body.data).toHaveLength(0);
    expect((await dev.get(`${base()}/tasks/${t.id}`)).body.data.commentCount).toBe(0);
  });

  it('records an activity feed visible to workspace members only', async () => {
    const t = await mkTask(dev, 'Feed me');
    await dev.patch(`${base()}/tasks/${t.id}`, { status: 'IN_PROGRESS' });
    await dev.post(`${base()}/tasks/${t.id}/comments`, { body: 'note' });

    const feed = await viewer.get(`${base()}/tasks/${t.id}/activity`);
    expect(feed.status).toBe(200);
    expect(feed.body.data.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['task.created', 'task.status_changed', 'comment.created']),
    );
    const proj = await viewer.get(`${base()}/projects/${P}/activity`);
    expect(proj.body.data.length).toBeGreaterThan(feed.body.data.length - 1);
    expect((await devOnly2.get(`${base()}/tasks/${t.id}/activity`)).status).toBe(404);
  });
});

describe('events, audit and deletion', () => {
  it('writes versioned outbox events in the same transaction', async () => {
    const t = await mkTask(dev, 'Evented', { assigneeId: (await dev.get('/auth/me')).body.data.user.id });
    await dev.patch(`${base()}/tasks/${t.id}`, { status: 'DONE' });
    const rows = await h.t.admin.selectFrom('outboxEvents').select(['type', 'payload']).where('organizationId', '=', org).execute();
    const mine = rows.filter((r) => (r.payload as { taskId?: string }).taskId === t.id).map((r) => r.type).sort();
    expect(mine).toEqual(['task.assigned.v1', 'task.created.v1', 'task.status_changed.v1', 'task.updated.v1']);
  });

  it('audits project/task lifecycle for admins', async () => {
    const logs = await owner.get(`${base()}/audit-logs?pageSize=100&action=project.created`);
    expect(logs.body.data.length).toBeGreaterThan(0);
    expect((await dev.get(`${base()}/audit-logs`)).status).toBe(403);
  });

  it('soft-deleting a project hides it and its tasks', async () => {
    const proj = (await pm.post(`${base()}/projects`, { workspaceId: ws1, name: 'Doomed', key: 'DOOM' })).body.data.id;
    const t = await mkTask(dev, 'doomed task', {}, proj);
    expect((await lead.delete(`${base()}/projects/${proj}`)).status).toBe(403); // lead lacks project:delete
    expect((await pm.delete(`${base()}/projects/${proj}`)).status).toBe(200);
    expect((await pm.get(`${base()}/projects/${proj}`)).status).toBe(404);
    expect((await dev.get(`${base()}/tasks/${t.id}`)).status).toBe(404);
  });

  it('requires CSRF on writes and a session on reads', async () => {
    const anon = h.client();
    expect((await anon.get(`${base()}/projects`)).status).toBe(401);
    const noCsrf = await dev.post(`${base()}/projects/${P}/tasks`, { title: 'x' }, { 'x-csrf-token': 'wrong' });
    expect(noCsrf.status).toBe(403);
  });
});
