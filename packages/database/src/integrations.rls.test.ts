import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, sql, withContext, type TestDatabase } from './index';

let t: TestDatabase;
const f = {} as Record<string, string>;

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const mkUser = async (e: string) => (await a.insertInto('users').values({ email: e, name: e, passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.owner = await mkUser('o@i.com'); f.admin = await mkUser('ad@i.com'); f.dev1 = await mkUser('d1@i.com'); f.dev2 = await mkUser('d2@i.com'); f.out = await mkUser('x@i.com');
  const mkOrg = async (n: string, o: string) => (await a.insertInto('organizations').values({ name: n, slug: n, createdBy: o }).returning('id').executeTakeFirstOrThrow()).id;
  f.org1 = await mkOrg('i1', f.owner); f.org2 = await mkOrg('i2', f.out);
  await a.insertInto('organizationMembers').values([
    { organizationId: f.org1, userId: f.owner, role: 'OWNER' }, { organizationId: f.org1, userId: f.admin, role: 'ADMIN' },
    { organizationId: f.org1, userId: f.dev1, role: 'DEVELOPER' }, { organizationId: f.org1, userId: f.dev2, role: 'DEVELOPER' }, { organizationId: f.org2, userId: f.out, role: 'OWNER' },
  ]).execute();
  const mkWs = async (n: string) => (await a.insertInto('workspaces').values({ organizationId: f.org1, name: n, slug: n }).returning('id').executeTakeFirstOrThrow()).id;
  f.ws1 = await mkWs('w1'); f.ws2 = await mkWs('w2');
  await a.insertInto('workspaceMembers').values([
    { organizationId: f.org1, workspaceId: f.ws1, userId: f.dev1, role: 'DEVELOPER' }, { organizationId: f.org1, workspaceId: f.ws2, userId: f.dev2, role: 'DEVELOPER' },
  ]).execute();
  const mkProj = async (ws: string, key: string) => (await a.insertInto('projects').values({ organizationId: f.org1, workspaceId: ws, key, name: key, createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.p1 = await mkProj(f.ws1, 'AA'); f.p2 = await mkProj(f.ws2, 'BB');
  f.t1 = (await a.insertInto('tasks').values({ organizationId: f.org1, workspaceId: f.ws1, projectId: f.p1, number: 1, title: 't', reporterId: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.t2 = (await a.insertInto('tasks').values({ organizationId: f.org1, workspaceId: f.ws2, projectId: f.p2, number: 1, title: 't', reporterId: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.int = (await a.insertInto('integrations').values({ organizationId: f.org1, provider: 'GITHUB', accountLogin: 'acme', accountId: '1', connectedBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('integrationTokens').values({ integrationId: f.int, organizationId: f.org1, tokenEnc: 'v1:x:y:z' }).execute();
  const repo = (ws: string, name: string) => a.insertInto('integrationRepos').values({ organizationId: f.org1, integrationId: f.int, workspaceId: ws, fullName: name, externalId: name, webhookSecretEnc: 'v1:a:b:c' }).returning('id').executeTakeFirstOrThrow().then((r) => r.id);
  f.r1 = await repo(f.ws1, 'acme/one'); f.r2 = await repo(f.ws2, 'acme/two');
  const item = (ws: string, repoId: string, id: string) => a.insertInto('externalItems').values({ organizationId: f.org1, workspaceId: ws, repoId, kind: 'PULL_REQUEST', externalId: id, title: 'PR', url: 'https://x/' + id }).returning('id').executeTakeFirstOrThrow().then((r) => r.id);
  f.i1 = await item(f.ws1, f.r1, '1'); f.i2 = await item(f.ws2, f.r2, '2');
}, 60_000);
afterAll(async () => t?.destroy());

const as = <T>(userId: string | undefined, orgId: string, fn: Parameters<typeof withContext<T>>[2]) => withContext(t.db, userId ? { userId, orgId } : { orgId }, fn);

describe('credentials', () => {
  it('are unreadable and unwritable in any user context, even for owners; the background context can use them', async () => {
    for (const u of [f.owner, f.admin, f.dev1]) {
      expect(await as(u, f.org1, (trx) => trx.selectFrom('integrationTokens').select('integrationId').execute())).toEqual([]);
    }
    await expect(as(f.owner, f.org1, (trx) => trx.insertInto('integrationTokens').values({ integrationId: f.int, organizationId: f.org1, tokenEnc: 'x' }).execute())).rejects.toThrow();
    expect(await as(undefined, f.org1, (trx) => trx.selectFrom('integrationTokens').select('tokenEnc').execute())).toHaveLength(1);
    expect(await as(undefined, f.org2, (trx) => trx.selectFrom('integrationTokens').select('tokenEnc').execute())).toEqual([]); // another org's worker context
  });
});

describe('visibility', () => {
  it('integrations and repositories are visible to org owners/admins only', async () => {
    for (const [u, n] of [[f.owner, 1], [f.admin, 1], [f.dev1, 0], [f.dev2, 0]] as const) {
      expect((await as(u, f.org1, (trx) => trx.selectFrom('integrations').select('id').execute())).length).toBe(n);
      expect((await as(u, f.org1, (trx) => trx.selectFrom('integrationRepos').select('id').execute())).length).toBe(n * 2);
    }
    expect(await as(f.out, f.org2, (trx) => trx.selectFrom('integrations').select('id').execute())).toEqual([]);
    expect(await as(f.out, f.org1, (trx) => trx.selectFrom('integrations').select('id').execute())).toEqual([]);
  });

  it('synced items follow workspace visibility and users cannot write them', async () => {
    const titles = (u: string) => as(u, f.org1, (trx) => trx.selectFrom('externalItems').select('id').execute()).then((r) => r.map((x) => x.id));
    expect(await titles(f.dev1)).toEqual([f.i1]);
    expect(await titles(f.dev2)).toEqual([f.i2]);
    expect((await titles(f.owner)).sort()).toEqual([f.i1, f.i2].sort());
    await expect(as(f.dev1, f.org1, (trx) => trx.insertInto('externalItems').values({ organizationId: f.org1, workspaceId: f.ws1, repoId: f.r1, kind: 'ISSUE', externalId: '9', title: 'x', url: 'u' }).execute())).rejects.toThrow(/row-level security/);
    const upd = await as(f.dev1, f.org1, (trx) => trx.updateTable('externalItems').set({ title: 'hax' }).where('id', '=', f.i1).executeTakeFirst());
    expect(Number(upd.numUpdatedRows)).toBe(0);
  });
});

describe('task links', () => {
  it('cannot link a task to an item from a different workspace', async () => {
    await expect(t.admin.insertInto('taskLinks').values({ organizationId: f.org1, workspaceId: f.ws1, taskId: f.t1, itemId: f.i2, source: 'AUTO' }).execute()).rejects.toThrow(/foreign key/);
    await expect(t.admin.insertInto('taskLinks').values({ organizationId: f.org1, workspaceId: f.ws1, taskId: f.t2, itemId: f.i1, source: 'AUTO' }).execute()).rejects.toThrow(/foreign key/);
  });
  it('are unique per task and item; users manage links only inside their workspaces', async () => {
    await as(f.dev1, f.org1, (trx) => trx.insertInto('taskLinks').values({ organizationId: f.org1, workspaceId: f.ws1, taskId: f.t1, itemId: f.i1, source: 'MANUAL', createdBy: f.dev1 }).execute());
    await expect(as(f.dev1, f.org1, (trx) => trx.insertInto('taskLinks').values({ organizationId: f.org1, workspaceId: f.ws1, taskId: f.t1, itemId: f.i1, source: 'MANUAL' }).execute())).rejects.toThrow(/duplicate key/);
    expect(await as(f.dev2, f.org1, (trx) => trx.selectFrom('taskLinks').select('id').execute())).toEqual([]);
    await as(f.dev1, f.org1, (trx) => trx.deleteFrom('taskLinks').where('taskId', '=', f.t1).execute());
  });
});

describe('webhooks', () => {
  const ev = (repo: string, delivery: string) => ({ organizationId: f.org1, repoId: repo, deliveryId: delivery, eventType: 'pull_request', payload: JSON.stringify({ a: 1 }) });
  it('are idempotent per repository delivery id, and invisible to users', async () => {
    await as(undefined, f.org1, (trx) => trx.insertInto('webhookEvents').values(ev(f.r1, 'd-1')).execute());
    await expect(as(undefined, f.org1, (trx) => trx.insertInto('webhookEvents').values(ev(f.r1, 'd-1')).execute())).rejects.toThrow(/duplicate key/);
    await as(undefined, f.org1, (trx) => trx.insertInto('webhookEvents').values(ev(f.r2, 'd-1')).execute()); // same id, different repo
    expect(await as(f.owner, f.org1, (trx) => trx.selectFrom('webhookEvents').select('id').execute())).toEqual([]);
    await expect(as(f.owner, f.org1, (trx) => trx.insertInto('webhookEvents').values(ev(f.r1, 'd-2')).execute())).rejects.toThrow(/row-level security/);
  });
  it('the lookup function exposes only what signature verification needs and reflects disconnection', async () => {
    const look = () => withContext(t.db, {}, async (trx) => (await sql<{ integrationStatus: string; repoActive: boolean }>`SELECT * FROM webhook_repo_lookup(${f.r1}::uuid)`.execute(trx)).rows[0]);
    expect(await look()).toMatchObject({ integrationStatus: 'CONNECTED', repoActive: true });
    const syncable = async () => withContext(t.db, {}, async (trx) => (await sql<{ repoId: string }>`SELECT * FROM job_sync_repos()`.execute(trx)).rows.map((r) => r.repoId));
    expect((await syncable()).sort()).toEqual([f.r1, f.r2].sort());
    await t.admin.updateTable('integrations').set({ status: 'DISCONNECTED' }).where('id', '=', f.int).execute();
    expect(await look()).toMatchObject({ integrationStatus: 'DISCONNECTED' });
    expect(await syncable()).toEqual([]); // disconnected integrations stop syncing
    await t.admin.updateTable('integrations').set({ status: 'CONNECTED' }).where('id', '=', f.int).execute();
  });
  it('only one active integration per provider per organization', async () => {
    await expect(t.admin.insertInto('integrations').values({ organizationId: f.org1, provider: 'GITHUB', accountLogin: 'again', accountId: '2', connectedBy: f.owner }).execute()).rejects.toThrow(/duplicate key/);
  });
});
