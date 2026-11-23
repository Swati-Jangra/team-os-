import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AIProviderError, LocalProvider } from '@teamos/ai-core';
import { createHarness, type Client, type Harness } from './harness';

let h: Harness;
let owner: Client;
let pm: Client; // PROJECT_MANAGER ws1
let dev1: Client; // DEVELOPER ws1
let dev2: Client; // DEVELOPER ws2
let viewer: Client;
let org: string;
let ws1: string;
let ws2: string;
let proj1: string;
let proj2: string;
let chatFail = false;
const base = () => `/organizations/${org}`;

class TestAI extends LocalProvider {
  constructor() {
    super(() => {
      if (chatFail) throw new AIProviderError('boom', true, 503);
      return undefined;
    });
  }
}

async function addMember(email: string, role: string, workspaceIds: string[]): Promise<Client> {
  const c = await h.signup(email);
  expect((await owner.post(`${base()}/invitations`, { email, role, workspaceIds })).status).toBe(201);
  expect((await c.post('/invitations/accept', { token: await h.tokenFor('member.invited.v1', email) })).status).toBe(200);
  return c;
}

beforeAll(async () => {
  h = await createHarness({}, new TestAI());
  owner = await h.signup('owner@m.com', 'Owner');
  org = (await owner.post('/organizations', { name: 'Meet Org' })).body.data.id;
  ws1 = (await owner.post(`${base()}/workspaces`, { name: 'Alpha' })).body.data.id;
  ws2 = (await owner.post(`${base()}/workspaces`, { name: 'Beta' })).body.data.id;
  proj1 = (await owner.post(`${base()}/projects`, { workspaceId: ws1, name: 'Apollo', key: 'APO', description: 'Launch the new onboarding flow for customers' })).body.data.id;
  proj2 = (await owner.post(`${base()}/projects`, { workspaceId: ws2, name: 'Beta Proj', key: 'BET' })).body.data.id;
  pm = await addMember('pm@m.com', 'PROJECT_MANAGER', [ws1]);
  dev1 = await addMember('dev1@m.com', 'DEVELOPER', [ws1]);
  dev2 = await addMember('dev2@m.com', 'DEVELOPER', [ws2]);
  viewer = await addMember('view@m.com', 'VIEWER', [ws1]);
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const mk = async (c: Client, extra: object = {}) => {
  const r = await c.post(`${base()}/meetings`, { workspaceId: ws1, title: 'Sync', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; status: string; items: unknown[] };
};
const addItem = async (meetingId: string, kind: 'DECISION' | 'ACTION_ITEM' | 'BLOCKER', text: string) => {
  const r = await h.t.admin.insertInto('meetingItems').values({ organizationId: org, workspaceId: ws1, meetingId, kind, text }).returning('id').executeTakeFirstOrThrow();
  return r.id;
};

describe('meetings CRUD & permissions', () => {
  it('PM creates; dev/viewer cannot; reads follow workspace visibility', async () => {
    const m = await mk(pm, { transcript: 'Decision: ship friday' });
    expect(m.status).toBe('DRAFT');
    expect((await dev1.post(`${base()}/meetings`, { workspaceId: ws1, title: 'x' })).status).toBe(403);
    expect((await viewer.get(`${base()}/meetings/${m.id}`)).status).toBe(200);
    expect((await dev1.get(`${base()}/meetings/${m.id}`)).status).toBe(200);
    expect((await dev2.get(`${base()}/meetings/${m.id}`)).status).toBe(404);
    const list = await dev2.get(`${base()}/meetings`);
    expect(list.body.data.map((x: { id: string }) => x.id)).not.toContain(m.id);
    expect(list.body.data[0]?.transcript).toBeUndefined();
    // project must be in the same workspace
    const bad = await pm.post(`${base()}/meetings`, { workspaceId: ws1, title: 'x', projectId: proj2 });
    expect(bad.status).toBe(400);
    const ev = await h.t.admin.selectFrom('outboxEvents').select('type').where('type', 'like', 'meeting.%').execute();
    expect(ev.map((e) => e.type)).toContain('meeting.created.v1');
  });

  it('update, soft delete, and 404 after delete', async () => {
    const m = await mk(pm);
    const u = await pm.patch(`${base()}/meetings/${m.id}`, { title: 'Renamed', projectId: proj1 });
    expect(u.status).toBe(200);
    expect(u.body.data.title).toBe('Renamed');
    expect((await dev1.patch(`${base()}/meetings/${m.id}`, { title: 'no' })).status).toBe(403);
    expect((await pm.delete(`${base()}/meetings/${m.id}`)).status).toBe(200);
    expect((await pm.get(`${base()}/meetings/${m.id}`)).status).toBe(404);
    const ev = await h.t.admin.selectFrom('outboxEvents').select('type').where('type', '=', 'meeting.deleted.v1').execute();
    expect(ev.length).toBeGreaterThan(0);
  });
});

describe('audio upload & processing request', () => {
  it('validates type/size, stores the file, and process needs content', async () => {
    const m = await mk(pm);
    expect((await pm.post(`${base()}/meetings/${m.id}/process`)).status).toBe(400); // nothing to process
    const bad = await pm.putRaw(`${base()}/meetings/${m.id}/audio`, Buffer.from('x'), 'audio/flac');
    expect(bad.status).toBe(400);
    const big = await pm.putRaw(`${base()}/meetings/${m.id}/audio`, Buffer.alloc(2 * 1024 * 1024, 1), 'audio/mpeg');
    expect(big.status).toBe(413);
    expect((await dev1.putRaw(`${base()}/meetings/${m.id}/audio`, Buffer.from('abc'), 'audio/mpeg')).status).toBe(403);
    expect((await dev2.putRaw(`${base()}/meetings/${m.id}/audio`, Buffer.from('abc'), 'audio/mpeg')).status).toBe(403);
    const ok = await pm.putRaw(`${base()}/meetings/${m.id}/audio`, Buffer.from('fake-audio'), 'audio/mpeg');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.hasAudio).toBe(true);
    expect(readdirSync(path.join(h.config.storageDir, org))).toContain(`${m.id}.mp3`);
    const p = await pm.post(`${base()}/meetings/${m.id}/process`);
    expect(p.status).toBe(200);
    expect(p.body.data.status).toBe('PROCESSING');
    expect((await pm.post(`${base()}/meetings/${m.id}/process`)).status).toBe(409); // already queued
    expect((await pm.patch(`${base()}/meetings/${m.id}`, { title: 'x' })).status).toBe(409);
    const ev = await h.t.admin.selectFrom('outboxEvents').select('type').where('type', '=', 'meeting.processing_requested.v1').execute();
    expect(ev.length).toBe(1);
  });
});

describe('item review: AI output needs human approval', () => {
  it('nothing becomes a task until approved; approval is atomic and single-use', async () => {
    const m = await mk(pm, { projectId: proj1 });
    const a = await addItem(m.id, 'ACTION_ITEM', 'Write the migration guide');
    const d = await addItem(m.id, 'DECISION', 'Use Postgres');
    const before = await h.t.admin.selectFrom('tasks').select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow();
    const detail = await dev1.get(`${base()}/meetings/${m.id}`);
    expect(detail.body.data.items).toHaveLength(2);
    // permission: dev may read but not decide
    expect((await dev1.post(`${base()}/meetings/${m.id}/items/${a}/approve`, { projectId: proj1 })).status).toBe(403);
    // action items need a project
    expect((await pm.post(`${base()}/meetings/${m.id}/items/${a}/approve`, {})).status).toBe(400);
    // project in another workspace is refused
    expect((await pm.post(`${base()}/meetings/${m.id}/items/${a}/approve`, { projectId: proj2 })).status).toBe(400);
    const afterFail = await h.t.admin.selectFrom('tasks').select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow();
    expect(afterFail.c).toBe(before.c);
    // edit then approve
    expect((await pm.patch(`${base()}/meetings/${m.id}/items/${a}`, { text: 'Write the migration guide v2', priority: 'HIGH' })).status).toBe(200);
    const ok = await pm.post(`${base()}/meetings/${m.id}/items/${a}/approve`, { projectId: proj1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const taskId = ok.body.data.taskId as string;
    const task = await h.t.admin.selectFrom('tasks').select(['title', 'projectId', 'priority']).where('id', '=', taskId).executeTakeFirstOrThrow();
    expect(task).toMatchObject({ title: 'Write the migration guide v2', projectId: proj1, priority: 'HIGH' });
    // second decision conflicts, no duplicate task
    expect((await pm.post(`${base()}/meetings/${m.id}/items/${a}/approve`, { projectId: proj1 })).status).toBe(409);
    expect((await pm.post(`${base()}/meetings/${m.id}/items/${a}/reject`)).status).toBe(409);
    expect((await pm.patch(`${base()}/meetings/${m.id}/items/${a}`, { text: 'again' })).status).toBe(409);
    const after = await h.t.admin.selectFrom('tasks').select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow();
    expect(Number(after.c)).toBe(Number(before.c) + 1);
    // decision: acknowledge creates no task; reject works
    const ack = await pm.post(`${base()}/meetings/${m.id}/items/${d}/approve`, {});
    expect(ack.status).toBe(200);
    expect(ack.body.data.taskId).toBeNull();
    const b = await addItem(m.id, 'BLOCKER', 'Waiting on vendor');
    const rej = await pm.post(`${base()}/meetings/${m.id}/items/${b}/reject`);
    expect(rej.body.data.item.status).toBe('REJECTED');
    const au = await h.t.admin.selectFrom('auditLogs').select('action').where('targetType', '=', 'meeting_item').execute();
    expect(au.map((x) => x.action)).toEqual(expect.arrayContaining(['meeting.item_approved', 'meeting.item_rejected']));
  });

  it('concurrent approvals create exactly one task', async () => {
    const m = await mk(pm, { projectId: proj1 });
    const a = await addItem(m.id, 'ACTION_ITEM', 'Race me');
    const before = Number((await h.t.admin.selectFrom('tasks').select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
    const rs = await Promise.all([1, 2, 3].map(() => pm.post(`${base()}/meetings/${m.id}/items/${a}/approve`, { projectId: proj1 })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const after = Number((await h.t.admin.selectFrom('tasks').select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
    expect(after).toBe(before + 1);
  });

  it('items of another workspace are invisible', async () => {
    const m = await mk(pm);
    const a = await addItem(m.id, 'DECISION', 'Secret');
    expect((await dev2.post(`${base()}/meetings/${m.id}/items/${a}/approve`, {})).status).toBe(403);
    expect((await owner.post(`${base()}/meetings/${m.id}/items/${randomUuid()}/approve`, {})).status).toBe(404);
  });
});

function randomUuid() {
  return '00000000-0000-4000-8000-000000000001';
}

describe('AI project planning', () => {
  it('proposal is read-only; apply creates tasks and ordered dependencies', async () => {
    const before = Number((await h.t.admin.selectFrom('tasks').select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
    const p = await dev1.post(`${base()}/projects/${proj1}/plan`, { goal: '- Design the flow\n- Build the API\n- Write tests' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.tasks.length).toBeGreaterThan(0);
    const mid = Number((await h.t.admin.selectFrom('tasks').select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
    expect(mid).toBe(before); // nothing created
    expect((await viewer.post(`${base()}/projects/${proj1}/plan`, { goal: 'something long enough' })).status).toBe(403);
    expect((await dev2.post(`${base()}/projects/${proj1}/plan`, { goal: 'something long enough' })).status).toBe(404);

    const ap = await dev1.post(`${base()}/projects/${proj1}/plan/apply`, {
      tasks: [
        { title: 'Design', dependsOn: [] },
        { title: 'Build', dependsOn: [0], estimateHours: 8 },
        { title: 'Test', dependsOn: [0, 1] },
      ],
    });
    expect(ap.status, JSON.stringify(ap.body)).toBe(201);
    expect(ap.body.data).toHaveLength(3);
    const deps = await h.t.admin.selectFrom('taskDependencies').select(['taskId', 'dependsOnTaskId']).where('taskId', 'in', ap.body.data.map((t: { id: string }) => t.id)).execute();
    expect(deps).toHaveLength(3);
    // forward / self references are rejected by validation
    expect((await dev1.post(`${base()}/projects/${proj1}/plan/apply`, { tasks: [{ title: 'A', dependsOn: [1] }, { title: 'B', dependsOn: [] }] })).status).toBe(400);
    expect((await viewer.post(`${base()}/projects/${proj1}/plan/apply`, { tasks: [{ title: 'A', dependsOn: [] }] })).status).toBe(403);
  });

  it('maps provider failure to 503 and needs a goal', async () => {
    chatFail = true;
    const r = await dev1.post(`${base()}/projects/${proj1}/plan`, { goal: 'Plan the launch properly please' });
    chatFail = false;
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('AI_UNAVAILABLE');
    const empty = await dev1.post(`${base()}/projects/${proj2}/plan`, {});
    expect([400, 404]).toContain(empty.status);
    const noGoal = await owner.post(`${base()}/projects/${proj2}/plan`, {});
    expect(noGoal.status).toBe(400);
  });
});
