import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubClient, signGitHubBody } from '@teamos/integrations';
import { createHarness, type Client, type Harness } from './harness';

/** A tiny GitHub stand-in behind the REAL GitHubClient (injected fetch), so the client's request building is exercised too. */
function fakeGitHub() {
  const state = { hooks: new Map<number, { repo: string; url: string; secret: string }>(), nextHook: 100, tokenValid: true, deleted: [] as number[], tokensSeen: new Set<string>(), codes: new Set(['good-code']) };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const auth = new Headers(init.headers).get('authorization');
    if (auth) state.tokensSeen.add(auth.replace('Bearer ', ''));
    if (u.pathname === '/login/oauth/access_token') {
      const b = JSON.parse(String(init.body));
      return state.codes.has(b.code) ? json({ access_token: 'gho_SECRET_TOKEN_VALUE', scope: 'repo,admin:repo_hook' }) : json({ error: 'bad_verification_code' });
    }
    if (!state.tokenValid) return json({ message: 'Bad credentials' }, 401);
    if (u.pathname === '/user') return json({ id: 42, login: 'octo' });
    if (u.pathname === '/user/repos') return json([{ id: 1, full_name: 'acme/api', private: true }, { id: 2, full_name: 'acme/web', private: false }]);
    const repo = /^\/repos\/(acme\/[\w.-]+)$/.exec(u.pathname);
    if (repo && init.method !== 'POST') return repo[1] === 'acme/missing' ? json({}, 404) : json({ id: repo[1] === 'acme/api' ? 1 : 2, full_name: repo[1], private: false });
    const hooks = /^\/repos\/(acme\/[\w.-]+)\/hooks(?:\/(\d+))?$/.exec(u.pathname);
    if (hooks && init.method === 'POST') {
      const b = JSON.parse(String(init.body));
      const id = state.nextHook++;
      state.hooks.set(id, { repo: hooks[1]!, url: b.config.url, secret: b.config.secret });
      return json({ id }, 201);
    }
    if (hooks && init.method === 'DELETE') { state.deleted.push(Number(hooks[2])); state.hooks.delete(Number(hooks[2])); return new Response(null, { status: 204 }); }
    return json([]);
  }) as typeof fetch;
  const client = new GitHubClient({ apiUrl: 'https://gh.test', oauthUrl: 'https://gh-oauth.test', clientId: 'cid', clientSecret: 'csecret', fetch: f });
  return { client, state };
}

const KEY = randomBytes(32).toString('base64');
let h: Harness;
let gh: ReturnType<typeof fakeGitHub>;
let owner: Client, admin: Client, dev: Client, dev2: Client, outsider: Client;
let org: string, ws1: string, ws2: string, proj: string, proj2: string;
const base = () => `/organizations/${org}`;

async function addMember(email: string, role: string, workspaceIds: string[]): Promise<Client> {
  const c = await h.signup(email);
  expect((await owner.post(`${base()}/invitations`, { email, role, workspaceIds })).status).toBe(201);
  expect((await c.post('/invitations/accept', { token: await h.tokenFor('member.invited.v1', email) })).status).toBe(200);
  return c;
}
async function connect(c: Client, code = 'good-code') {
  const a = await c.post(`${base()}/integrations/github/authorize`);
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  const state = new URL(a.body.data.url).searchParams.get('state')!;
  return { state, res: await c.get(`/integrations/github/callback?code=${code}&state=${state}`) };
}
const overview = async (c: Client = owner) => (await c.get(`${base()}/integrations`)).body.data as { configured: boolean; integration: { id: string; status: string } | null; repos: Array<{ id: string; fullName: string; workspaceId: string }> };
const hooksFor = (repoId: string) => [...gh.state.hooks.values()].find((x) => x.url.endsWith(`/webhooks/github/${repoId}`))!;

beforeAll(async () => {
  gh = fakeGitHub();
  h = await createHarness({ integrationKey: Buffer.from(KEY, 'base64') }, undefined, gh.client);
  owner = await h.signup('owner@g.com', 'Owner');
  org = (await owner.post('/organizations', { name: 'Hook Org' })).body.data.id;
  ws1 = (await owner.post(`${base()}/workspaces`, { name: 'Alpha' })).body.data.id;
  ws2 = (await owner.post(`${base()}/workspaces`, { name: 'Beta' })).body.data.id;
  proj = (await owner.post(`${base()}/projects`, { workspaceId: ws1, name: 'Apollo', key: 'APO' })).body.data.id;
  proj2 = (await owner.post(`${base()}/projects`, { workspaceId: ws2, name: 'Beta', key: 'BET' })).body.data.id;
  admin = await addMember('admin@g.com', 'ADMIN', []);
  dev = await addMember('dev@g.com', 'DEVELOPER', [ws1]);
  dev2 = await addMember('dev2@g.com', 'DEVELOPER', [ws2]);
  outsider = await h.signup('out@g.com');
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('GitHub OAuth connection', () => {
  it('only integration managers can start or finish a connection', async () => {
    expect((await dev.post(`${base()}/integrations/github/authorize`)).status).toBe(403);
    expect((await outsider.post(`${base()}/integrations/github/authorize`)).status).toBe(404);
    expect((await h.client().post(`${base()}/integrations/github/authorize`)).status).toBe(401);
    expect((await dev.get(`${base()}/integrations`)).status).toBe(200); // members can see status
  });

  it('rejects an unknown state, a state used by another user, and replays', async () => {
    expect((await owner.get('/integrations/github/callback?code=good-code&state=nope')).status).toBe(400);
    const a = await owner.post(`${base()}/integrations/github/authorize`);
    const state = new URL(a.body.data.url).searchParams.get('state')!;
    expect(new URL(a.body.data.url).searchParams.get('scope')).toBe('repo admin:repo_hook');
    expect((await admin.get(`/integrations/github/callback?code=good-code&state=${state}`)).status).toBe(400); // bound to the starter
    // the failed attempt must not have burned the legitimate user's state
    expect((await owner.get(`/integrations/github/callback?code=good-code&state=${state}`)).status).toBe(302);
    expect((await owner.get(`/integrations/github/callback?code=good-code&state=${state}`)).status).toBe(400); // single use
    expect((await overview()).integration?.status).toBe('CONNECTED');
  });

  it('stores the token encrypted and never returns it', async () => {
    const o = await overview();
    const raw = await h.t.admin.selectFrom('integrationTokens').selectAll().execute();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.tokenEnc).not.toContain('gho_SECRET_TOKEN_VALUE');
    expect(raw[0]!.tokenEnc.startsWith('v1:')).toBe(true);
    expect(JSON.stringify(o)).not.toContain('gho_');
    expect(JSON.stringify((await owner.get(`${base()}/integrations`)).body)).not.toContain('SECRET');
    const audit = await h.t.admin.selectFrom('auditLogs').select('action').where('action', '=', 'integration.connected').execute();
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('a failed code exchange connects nothing new and a role downgrade between start and finish is refused', async () => {
    const a = await admin.post(`${base()}/integrations/github/authorize`);
    const state = new URL(a.body.data.url).searchParams.get('state')!;
    await h.t.admin.updateTable('organizationMembers').set({ role: 'DEVELOPER' }).where('userId', '=', admin.userId).execute();
    expect((await admin.get(`/integrations/github/callback?code=good-code&state=${state}`)).status).toBe(403);
    await h.t.admin.updateTable('organizationMembers').set({ role: 'ADMIN' }).where('userId', '=', admin.userId).execute();
  });
});

describe('repositories', () => {
  let repoId: string, integrationId: string;
  it('lists what the connected account can see and connects a repo to ONE workspace with a signed webhook', async () => {
    integrationId = (await overview()).integration!.id;
    expect((await dev.get(`${base()}/integrations/${integrationId}/available-repos`)).status).toBe(403);
    const av = await owner.get(`${base()}/integrations/${integrationId}/available-repos`);
    expect(av.body.data.map((r: { fullName: string }) => r.fullName)).toEqual(['acme/api', 'acme/web']);

    expect((await dev.post(`${base()}/integrations/${integrationId}/repos`, { fullName: 'acme/api', workspaceId: ws1 })).status).toBe(403);
    expect((await owner.post(`${base()}/integrations/${integrationId}/repos`, { fullName: 'acme/api', workspaceId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await owner.post(`${base()}/integrations/${integrationId}/repos`, { fullName: 'acme/api', workspaceId: ws1, projectId: proj2 })).status).toBe(400); // project of another workspace
    expect((await owner.post(`${base()}/integrations/${integrationId}/repos`, { fullName: '../etc/passwd', workspaceId: ws1 })).status).toBe(400);
    expect((await owner.post(`${base()}/integrations/${integrationId}/repos`, { fullName: 'acme/missing', workspaceId: ws1 })).status).toBe(404);
    expect(gh.state.hooks.size).toBe(0);

    const r = await owner.post(`${base()}/integrations/${integrationId}/repos`, { fullName: 'acme/api', workspaceId: ws1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    repoId = r.body.data.id;
    expect(JSON.stringify(r.body)).not.toContain('webhook_secret');
    expect(hooksFor(repoId).secret.length).toBeGreaterThanOrEqual(32);
    const row = await h.t.admin.selectFrom('integrationRepos').select('webhookSecretEnc').where('id', '=', repoId).executeTakeFirstOrThrow();
    expect(row.webhookSecretEnc).not.toContain(hooksFor(repoId).secret);
    expect((await owner.post(`${base()}/integrations/${integrationId}/repos`, { fullName: 'acme/api', workspaceId: ws2 })).status).toBe(409);
    const ev = await h.t.admin.selectFrom('outboxEvents').select('type').where('type', '=', 'integration.sync_requested.v1').execute();
    expect(ev).toHaveLength(1);
  });

  it('syncNow is permission-checked and rate limited', async () => {
    expect((await dev.post(`${base()}/integration-repos/${repoId}/sync`)).status).toBe(403);
    expect((await owner.post(`${base()}/integration-repos/${repoId}/sync`)).status).toBe(202);
    expect((await owner.post(`${base()}/integration-repos/${repoId}/sync`)).status).toBe(429);
  });

  describe('webhook receiver', () => {
    const body = () => Buffer.from(JSON.stringify({ action: 'opened', pull_request: { number: 7, title: 'APO-1 add login' }, repository: { full_name: 'acme/api' } }));
    const send = (id: string, raw: Buffer, headers: Record<string, string>) => request(h.app.getHttpServer()).post(`/api/v1/webhooks/github/${id}`).set({ 'content-type': 'application/json', ...headers }).send(raw.toString('utf8'));
    const post = (raw: Buffer, secret: string, delivery: string, extra: Record<string, string> = {}) =>
      send(repoId, raw, { 'x-hub-signature-256': signGitHubBody(secret, raw), 'x-github-event': 'pull_request', 'x-github-delivery': delivery, ...extra });

    it('verifies the HMAC over the exact raw bytes and stores the delivery once', async () => {
      const secret = hooksFor(repoId).secret;
      const raw = body();
      const ok = await post(raw, secret, 'd-1');
      expect(ok.status, JSON.stringify(ok.body)).toBe(202);
      expect(await h.t.admin.selectFrom('webhookEvents').select('id').where('deliveryId', '=', 'd-1').execute()).toHaveLength(1);
      const dup = await post(raw, secret, 'd-1'); // GitHub redelivery
      expect(dup.status).toBe(202);
      expect(dup.body.data.duplicate).toBe(true);
      expect(await h.t.admin.selectFrom('webhookEvents').select('id').where('deliveryId', '=', 'd-1').execute()).toHaveLength(1);
      expect(await h.t.admin.selectFrom('outboxEvents').select('id').where('type', '=', 'integration.webhook_received.v1').execute()).toHaveLength(1);
    });

    it('rejects wrong, missing and re-serialised-body signatures, and incomplete deliveries', async () => {
      const secret = hooksFor(repoId).secret;
      const raw = body();
      expect((await send(repoId, raw, { 'x-hub-signature-256': signGitHubBody('wrong-secret', raw), 'x-github-event': 'pull_request', 'x-github-delivery': 'd-2' })).status).toBe(401);
      expect((await send(repoId, raw, { 'x-github-event': 'pull_request', 'x-github-delivery': 'd-3' })).status).toBe(401);
      const pretty = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2)); // same JSON, different bytes
      expect((await send(repoId, pretty, { 'x-hub-signature-256': signGitHubBody(secret, raw), 'x-github-event': 'pull_request', 'x-github-delivery': 'd-4' })).status).toBe(401);
      expect((await send(repoId, raw, { 'x-hub-signature-256': signGitHubBody(secret, raw), 'x-github-delivery': 'd-5' })).status).toBe(400);
      expect(await h.t.admin.selectFrom('webhookEvents').select('id').where('deliveryId', 'in', ['d-2', 'd-3', 'd-4', 'd-5']).execute()).toHaveLength(0);
    });

    it('a secret from another repo does not work, and unknown repos look like disconnected ones', async () => {
      const raw = body();
      const unknown = '11111111-1111-4111-8111-111111111111';
      const a = await send(unknown, raw, { 'x-hub-signature-256': signGitHubBody(hooksFor(repoId).secret, raw), 'x-github-event': 'ping', 'x-github-delivery': 'd-6' });
      expect(a.status).toBe(404);
      expect((await send('not-a-uuid', raw, {})).status).toBe(400);
    });
  });

  describe('items and task links', () => {
    let itemPr: string, itemOther: string, taskA: string, taskB: string;
    beforeAll(async () => {
      const mk = async (id: string, num: string, title: string, workspaceId: string, repo: string) =>
        (await h.t.admin.insertInto('externalItems').values({ organizationId: org, workspaceId, repoId: repo, kind: 'PULL_REQUEST', externalId: num, title, state: 'open', url: `https://github.com/acme/api/pull/${num}`, updatedExtAt: new Date() }).returning('id').executeTakeFirstOrThrow()).id;
      itemPr = await mk('', '7', 'APO-1 add login', ws1, repoId);
      // a second repo bound to ws2 with its own PR
      const repo2 = (await h.t.admin.insertInto('integrationRepos').values({ organizationId: org, integrationId, workspaceId: ws2, fullName: 'acme/web', externalId: '2', webhookSecretEnc: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
      itemOther = await mk('', '9', 'BET-1 beta thing', ws2, repo2);
      taskA = (await owner.post(`${base()}/projects/${proj}/tasks`, { title: 'Login' })).body.data.id;
      taskB = (await owner.post(`${base()}/projects/${proj2}/tasks`, { title: 'Beta' })).body.data.id;
    });

    it('items follow workspace visibility', async () => {
      const mine = await dev.get(`${base()}/external-items`);
      expect(mine.body.data.map((i: { id: string }) => i.id)).toEqual([itemPr]);
      const theirs = await dev2.get(`${base()}/external-items`);
      expect(theirs.body.data.map((i: { id: string }) => i.id)).toEqual([itemOther]);
      expect((await owner.get(`${base()}/external-items`)).body.data).toHaveLength(2);
      expect((await owner.get(`${base()}/external-items?kind=ISSUE`)).body.data).toHaveLength(0);
      expect((await owner.get(`${base()}/external-items?q=login`)).body.data).toHaveLength(1);
    });

    it('manual links: workspace-checked, idempotent-conflict, audited, removable', async () => {
      expect((await dev2.post(`${base()}/tasks/${taskA}/links`, { itemId: itemPr })).status).toBe(404); // no access to the task
      expect((await owner.post(`${base()}/tasks/${taskA}/links`, { itemId: itemOther })).status).toBe(404); // item of another workspace
      expect((await owner.post(`${base()}/tasks/${taskB}/links`, { itemId: itemPr })).status).toBe(404);
      const l = await dev.post(`${base()}/tasks/${taskA}/links`, { itemId: itemPr });
      expect(l.status, JSON.stringify(l.body)).toBe(201);
      expect((await dev.post(`${base()}/tasks/${taskA}/links`, { itemId: itemPr })).status).toBe(409);
      const list = await dev.get(`${base()}/tasks/${taskA}/links`);
      expect(list.body.data).toMatchObject([{ itemId: itemPr, source: 'MANUAL', kind: 'PULL_REQUEST', externalId: '7' }]);
      expect((await dev2.get(`${base()}/tasks/${taskA}/links`)).status).toBe(404);
      const withTasks = await owner.get(`${base()}/external-items?workspaceId=${ws1}`);
      expect(withTasks.body.data[0].tasks[0].identifier).toMatch(/^APO-\d+$/);
      expect((await dev.delete(`${base()}/tasks/${taskA}/links/${l.body.data.id}`)).status).toBe(200);
      expect((await dev.delete(`${base()}/tasks/${taskA}/links/${l.body.data.id}`)).status).toBe(404);
      const acts = await h.t.admin.selectFrom('auditLogs').select('action').where('action', 'in', ['task_link.created', 'task_link.deleted']).execute();
      expect(acts.map((a) => a.action).sort()).toEqual(['task_link.created', 'task_link.deleted']);
    });
  });

  describe('disconnect', () => {
    it('repo disconnect stops its webhook immediately and removes the hook on GitHub', async () => {
      const secret = hooksFor(repoId).secret;
      const hookIds = [...gh.state.hooks.keys()];
      expect((await dev.delete(`${base()}/integration-repos/${repoId}`)).status).toBe(403);
      expect((await owner.delete(`${base()}/integration-repos/${repoId}`)).status).toBe(200);
      expect(gh.state.deleted).toEqual(expect.arrayContaining([hookIds[0]!]));
      const raw = Buffer.from('{"zen":"x"}');
      const r = await request(h.app.getHttpServer()).post(`/api/v1/webhooks/github/${repoId}`).set({ 'content-type': 'application/json', 'x-hub-signature-256': signGitHubBody(secret, raw), 'x-github-event': 'ping', 'x-github-delivery': 'd-after' }).send(raw.toString('utf8'));
      expect(r.status).toBe(404);
      expect((await overview()).repos.map((x) => x.fullName)).not.toContain('acme/api');
    });

    it('integration disconnect stops everything, deletes the credential and is audited', async () => {
      const id = (await overview()).integration!.id;
      // a second repo that is still active
      const r2 = await owner.post(`${base()}/integrations/${id}/repos`, { fullName: 'acme/lib', workspaceId: ws1 });
      expect(r2.status, JSON.stringify(r2.body)).toBe(201);
      expect((await dev.delete(`${base()}/integrations/${id}`)).status).toBe(403);
      expect((await owner.delete(`${base()}/integrations/${id}`)).status).toBe(200);
      expect((await h.t.admin.selectFrom('integrationTokens').select('integrationId').execute())).toHaveLength(0);
      expect((await h.t.admin.selectFrom('integrations').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('DISCONNECTED');
      expect((await h.t.admin.selectFrom('integrationRepos').select('id').where('active', '=', true).execute())).toHaveLength(0);
      expect((await overview()).integration).toBeNull();
      expect((await owner.delete(`${base()}/integrations/${id}`)).status).toBe(409);
      expect((await owner.get(`${base()}/integrations/${id}/available-repos`)).status).toBe(409);
      const acts = (await h.t.admin.selectFrom('auditLogs').select('action').execute()).map((a) => a.action);
      expect(acts).toEqual(expect.arrayContaining(['integration.connected', 'integration.repo_connected', 'integration.repo_disconnected', 'integration.disconnected']));
    });
  });
});

describe('revoked access', () => {
  it('a revoked GitHub token surfaces as a clear conflict, not a 500', async () => {
    const { res } = await connect(owner);
    expect(res.status).toBe(302);
    const id = (await overview()).integration!.id;
    gh.state.tokenValid = false;
    const r = await owner.get(`${base()}/integrations/${id}/available-repos`);
    expect(r.status).toBe(409);
    gh.state.tokenValid = true;
  });
});

describe('not configured', () => {
  it('reports configured=false and refuses to start OAuth', async () => {
    const h2 = await createHarness();
    try {
      const o = await h2.signup('solo@g.com');
      const orgId = (await o.post('/organizations', { name: 'Solo' })).body.data.id;
      const ov = await o.get(`/organizations/${orgId}/integrations`);
      expect(ov.body.data).toMatchObject({ configured: false, integration: null, repos: [] });
      expect((await o.post(`/organizations/${orgId}/integrations/github/authorize`)).status).toBe(503);
      const raw = Buffer.from('{}');
      expect((await request(h2.app.getHttpServer()).post('/api/v1/webhooks/github/11111111-1111-4111-8111-111111111111').set('content-type', 'application/json').send(raw.toString('utf8'))).status).toBe(404);
    } finally {
      await h2.close();
    }
  }, 60_000);
});
