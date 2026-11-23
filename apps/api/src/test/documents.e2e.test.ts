import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AIProviderError, LocalProvider, type ChatRequest } from '@teamos/ai-core';
import { createProcessorForTests } from './knowledge-indexer';
import { createHarness, type Client, type Harness } from './harness';

let h: Harness;
let owner: Client;
let dev1: Client; // DEVELOPER ws1
let dev2: Client; // DEVELOPER ws2
let viewer: Client; // VIEWER ws1
let outsider: Client;
let org: string;
let ws1: string;
let ws2: string;
let index: (docId: string, type?: 'created' | 'updated' | 'deleted', version?: number) => Promise<unknown>;
let chatFail = false;
let lastChat: ChatRequest | undefined;
const base = () => `/organizations/${org}`;

class TestAI extends LocalProvider {
  constructor() {
    super((req) => {
      lastChat = req;
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
  const ai = new TestAI();
  h = await createHarness({}, ai);
  owner = await h.signup('owner@d.com', 'Owner');
  outsider = await h.signup('out@d.com', 'Outsider');
  org = (await owner.post('/organizations', { name: 'Docs Org' })).body.data.id;
  await outsider.post('/organizations', { name: 'Other Org' });
  ws1 = (await owner.post(`${base()}/workspaces`, { name: 'Alpha' })).body.data.id;
  ws2 = (await owner.post(`${base()}/workspaces`, { name: 'Beta' })).body.data.id;
  dev1 = await addMember('dev1@d.com', 'DEVELOPER', [ws1]);
  dev2 = await addMember('dev2@d.com', 'DEVELOPER', [ws2]);
  viewer = await addMember('view@d.com', 'VIEWER', [ws1]);
  index = createProcessorForTests(h, ai, org);
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const mk = async (c: Client, ws: string, title: string, contentHtml = '<p>hello</p>', extra: object = {}) => {
  const r = await c.post(`${base()}/documents`, { workspaceId: ws, title, contentHtml, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; version: number; contentHtml: string };
};

describe('documents', () => {
  it('creates, reads, lists with workspace visibility, and records outbox + audit', async () => {
    const d = await mk(dev1, ws1, 'Roadmap');
    expect(d.version).toBe(1);
    expect((await dev1.get(`${base()}/documents/${d.id}`)).status).toBe(200);
    expect((await dev2.get(`${base()}/documents/${d.id}`)).status).toBe(404); // other workspace
    expect((await outsider.get(`${base()}/documents/${d.id}`)).status).toBe(404);
    expect((await owner.get(`${base()}/documents/${d.id}`)).status).toBe(200); // org owner sees all
    const list = await dev2.get(`${base()}/documents`);
    expect(list.body.data.map((x: { id: string }) => x.id)).not.toContain(d.id);
    const ownerList = await owner.get(`${base()}/documents`);
    expect(ownerList.body.data.length).toBeGreaterThan(0);
    expect(ownerList.body.data[0]).not.toHaveProperty('contentHtml'); // summaries stay light
    const ev = await h.t.admin.selectFrom('outboxEvents').select('type').where('type', 'like', 'document.%').execute();
    expect(ev.map((e) => e.type)).toContain('document.created.v1');
    const au = await h.t.admin.selectFrom('auditLogs').select('action').where('targetId', '=', d.id).execute();
    expect(au.map((a) => a.action)).toContain('document.created');
  });

  it('enforces permissions and cross-workspace access', async () => {
    expect((await viewer.post(`${base()}/documents`, { workspaceId: ws1, title: 'x' })).status).toBe(403);
    expect((await dev1.post(`${base()}/documents`, { workspaceId: ws2, title: 'x' })).status).toBe(404); // can't see ws2
    expect((await viewer.get(`${base()}/documents`)).status).toBe(200);
    const d = await mk(dev1, ws1, 'Locked');
    expect((await viewer.patch(`${base()}/documents/${d.id}`, { title: 'hax', expectedVersion: 1 })).status).toBe(403);
    expect((await dev2.patch(`${base()}/documents/${d.id}`, { title: 'hax', expectedVersion: 1 })).status).toBe(404);
    expect((await dev2.delete(`${base()}/documents/${d.id}`)).status).toBe(404);
    expect((await outsider.get(`${base()}/documents`)).status).toBe(404);
  });

  it('validates input and project linkage', async () => {
    expect((await dev1.post(`${base()}/documents`, { workspaceId: ws1, title: '' })).status).toBe(400);
    expect((await dev1.post(`${base()}/documents`, { workspaceId: 'nope', title: 'x' })).status).toBe(400);
    const pm = (await owner.post(`${base()}/projects`, { workspaceId: ws2, name: 'Other WS project' })).body.data.id;
    expect((await dev1.post(`${base()}/documents`, { workspaceId: ws1, title: 'x', projectId: pm })).status).toBe(400);
    const p1 = (await owner.post(`${base()}/projects`, { workspaceId: ws1, name: 'Linked project' })).body.data.id;
    const d = await mk(dev1, ws1, 'Linked', '<p>x</p>', { projectId: p1 });
    expect((await dev1.get(`${base()}/documents?projectId=${p1}`)).body.data.map((x: { id: string }) => x.id)).toEqual([d.id]);
    expect((await dev1.patch(`${base()}/documents/${d.id}`, { expectedVersion: 1 })).status).toBe(400); // nothing to update
  });

  it('sanitises HTML on the server', async () => {
    const d = await mk(dev1, ws1, 'XSS', '<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://ok.example">ok</a><img src=x onerror=alert(1)><iframe src="//evil"></iframe>');
    const html = d.contentHtml;
    expect(html).not.toMatch(/script|onclick|onerror|javascript:|iframe|<img/i);
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('rel="noopener noreferrer"');
    const up = await dev1.patch(`${base()}/documents/${d.id}`, { contentHtml: '<p>clean</p><style>body{display:none}</style>', expectedVersion: 1 });
    expect(up.body.data.contentHtml).toBe('<p>clean</p>');
  });

  it('keeps immutable version history, detects stale edits and restores as a new version', async () => {
    const d = await mk(dev1, ws1, 'Spec v1', '<p>one</p>');
    const v2 = await dev1.patch(`${base()}/documents/${d.id}`, { title: 'Spec', contentHtml: '<p>two</p>', expectedVersion: 1 });
    expect(v2.body.data.version).toBe(2);
    const stale = await dev1.patch(`${base()}/documents/${d.id}`, { contentHtml: '<p>stale</p>', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    const versions = await dev1.get(`${base()}/documents/${d.id}/versions`);
    expect(versions.body.data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await dev1.get(`${base()}/documents/${d.id}/versions/1`)).body.data.contentHtml).toBe('<p>one</p>');
    expect((await dev1.get(`${base()}/documents/${d.id}/versions/9`)).status).toBe(404);
    expect((await dev2.get(`${base()}/documents/${d.id}/versions`)).status).toBe(404);
    const restored = await dev1.post(`${base()}/documents/${d.id}/versions/1/restore`, { expectedVersion: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ version: 3, title: 'Spec v1', contentHtml: '<p>one</p>' });
    expect((await dev1.get(`${base()}/documents/${d.id}/versions`)).body.data).toHaveLength(3);
  });

  it('soft-deletes and hides the document', async () => {
    const d = await mk(dev1, ws1, 'Temp');
    expect((await dev1.delete(`${base()}/documents/${d.id}`)).status).toBe(200);
    expect((await dev1.get(`${base()}/documents/${d.id}`)).status).toBe(404);
    expect((await dev1.delete(`${base()}/documents/${d.id}`)).status).toBe(404);
  });
});

describe('knowledge search and ask', () => {
  let rollout: string;
  let budget: string;
  beforeAll(async () => {
    rollout = (await mk(dev1, ws1, 'Production rollout plan', '<h2>Canary</h2><p>The canary release starts Monday for ten percent of customers.</p>')).id;
    budget = (await mk(dev2, ws2, 'Confidential budget', '<p>Quarterly headcount budget forecast is approved.</p>')).id;
    await index(rollout);
    await index(budget);
  });

  it('finds content by keyword and filters by what the caller can access', async () => {
    const r1 = await dev1.post(`${base()}/knowledge/search`, { query: 'canary release' });
    expect(r1.status).toBe(200);
    expect(r1.body.data.results[0]).toMatchObject({ sourceId: rollout, title: 'Production rollout plan', heading: 'Canary' });
    expect(r1.body.data.results[0].snippet).toContain('canary release');
    // dev1 cannot see ws2's document even when searching for its exact words
    const hidden = await dev1.post(`${base()}/knowledge/search`, { query: 'headcount budget forecast' });
    expect(hidden.body.data.results.map((r: { sourceId: string }) => r.sourceId)).not.toContain(budget);
    const own = await dev2.post(`${base()}/knowledge/search`, { query: 'headcount budget forecast' });
    expect(own.body.data.results[0].sourceId).toBe(budget);
    const all = await owner.post(`${base()}/knowledge/search`, { query: 'budget canary' });
    expect(new Set(all.body.data.results.map((r: { sourceId: string }) => r.sourceId))).toEqual(new Set([rollout, budget]));
    expect((await outsider.post(`${base()}/knowledge/search`, { query: 'canary' })).status).toBe(404);
  });

  it('removes results immediately when access is revoked or the document is deleted', async () => {
    const d = await mk(dev1, ws1, 'Ephemeral', '<p>zebrafish migration notes</p>');
    await index(d.id);
    expect((await dev1.post(`${base()}/knowledge/search`, { query: 'zebrafish' })).body.data.results).toHaveLength(1);
    // soft delete: hidden at query time even BEFORE the indexer has processed the delete event
    await dev1.delete(`${base()}/documents/${d.id}`);
    expect((await dev1.post(`${base()}/knowledge/search`, { query: 'zebrafish' })).body.data.results).toHaveLength(0);
    // member removed from the workspace: no more access, even though the chunks still exist
    const d2 = await mk(owner, ws2, 'Beta only', '<p>narwhal secrets</p>');
    await index(d2.id);
    expect((await dev2.post(`${base()}/knowledge/search`, { query: 'narwhal' })).body.data.results).toHaveLength(1);
    await h.t.admin.updateTable('workspaceMembers').set({ deletedAt: new Date() }).where('userId', '=', dev2.userId).execute();
    expect((await dev2.post(`${base()}/knowledge/search`, { query: 'narwhal' })).body.data.results).toHaveLength(0);
    await h.t.admin.updateTable('workspaceMembers').set({ deletedAt: null }).where('userId', '=', dev2.userId).execute();
  });

  it('answers with citations to real sources only, and records usage', async () => {
    const r = await dev1.post(`${base()}/knowledge/ask`, { question: 'When does the canary release start?' });
    expect(r.status).toBe(200);
    expect(r.body.data.grounded).toBe(true);
    expect(r.body.data.answer).toMatch(/\[1\]/);
    expect(r.body.data.sources[0]).toMatchObject({ n: 1, sourceId: rollout, cited: true, title: 'Production rollout plan' });
    expect(r.body.data.sources.every((s: { sourceId: string }) => s.sourceId !== budget)).toBe(true);
    // prompt hardening is present and sources are delimited
    const sys = lastChat!.messages.find((m) => m.role === 'system')!.content;
    expect(sys).toMatch(/untrusted/);
    expect(lastChat!.messages.at(-1)!.content).toContain('<sources>');
    const usage = await h.t.admin.selectFrom('aiUsage').select('feature').where('userId', '=', dev1.userId).execute();
    expect(usage.map((u) => u.feature)).toEqual(expect.arrayContaining(['search', 'ask']));
  });

  it('does not call the model when nothing relevant exists, and reports provider outages as 503', async () => {
    lastChat = undefined;
    const none = await dev1.post(`${base()}/knowledge/ask`, { question: 'qqqq zzzz xxxx' });
    expect(none.body.data).toMatchObject({ grounded: false, sources: [] });
    expect(lastChat).toBeUndefined();
    chatFail = true;
    const down = await dev1.post(`${base()}/knowledge/ask`, { question: 'canary release start' });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('AI_UNAVAILABLE');
    chatFail = false;
  });

  it('validates input, permission and rate limits per user', async () => {
    expect((await dev1.post(`${base()}/knowledge/search`, { query: 'a' })).status).toBe(400);
    expect((await viewer.post(`${base()}/knowledge/ask`, { question: 'what is the plan?' })).status).toBe(403); // no ai:use
    expect((await viewer.post(`${base()}/knowledge/search`, { query: 'canary' })).status).toBe(200); // read-only is fine
    let last = 200;
    for (let i = 0; i < 62 && last !== 429; i++) last = (await owner.post(`${base()}/knowledge/ask`, { question: 'canary question?' })).status;
    expect(last).toBe(429);
  });
});
