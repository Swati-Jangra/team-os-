import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, withContext, type TestDatabase } from './index';

let t: TestDatabase;
const f = {} as Record<string, string>;

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const mkUser = async (e: string) =>
    (await a.insertInto('users').values({ email: e, name: e, passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.owner1 = await mkUser('o1@x.com');
  f.dev1 = await mkUser('d1@x.com'); // member of ws1a only
  f.owner2 = await mkUser('o2@x.com');
  const mkOrg = async (n: string, owner: string) =>
    (await a.insertInto('organizations').values({ name: n, slug: n, createdBy: owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.org1 = await mkOrg('org1', f.owner1);
  f.org2 = await mkOrg('org2', f.owner2);
  await a.insertInto('organizationMembers').values([
    { organizationId: f.org1, userId: f.owner1, role: 'OWNER' },
    { organizationId: f.org1, userId: f.dev1, role: 'DEVELOPER' },
    { organizationId: f.org2, userId: f.owner2, role: 'OWNER' },
  ]).execute();
  const mkWs = async (org: string, slug: string) =>
    (await a.insertInto('workspaces').values({ organizationId: org, name: slug, slug }).returning('id').executeTakeFirstOrThrow()).id;
  f.ws1a = await mkWs(f.org1, 'w1a');
  f.ws1b = await mkWs(f.org1, 'w1b');
  f.ws2a = await mkWs(f.org2, 'w2a');
  await a.insertInto('workspaceMembers').values({ organizationId: f.org1, workspaceId: f.ws1a, userId: f.dev1, role: 'DEVELOPER' }).execute();

  const mkProject = async (org: string, ws: string, key: string, by: string) =>
    (await a.insertInto('projects').values({ organizationId: org, workspaceId: ws, key, name: key, createdBy: by }).returning('id').executeTakeFirstOrThrow()).id;
  f.p1a = await mkProject(f.org1, f.ws1a, 'AAA', f.owner1);
  f.p1b = await mkProject(f.org1, f.ws1b, 'BBB', f.owner1);
  f.p2a = await mkProject(f.org2, f.ws2a, 'CCC', f.owner2);
  const mkTask = async (org: string, ws: string, p: string, n: number, by: string) =>
    (await a.insertInto('tasks').values({ organizationId: org, workspaceId: ws, projectId: p, number: n, title: `t${n}`, reporterId: by }).returning('id').executeTakeFirstOrThrow()).id;
  f.t1a = await mkTask(f.org1, f.ws1a, f.p1a, 1, f.owner1);
  f.t1b = await mkTask(f.org1, f.ws1b, f.p1b, 1, f.owner1);
  f.t2a = await mkTask(f.org2, f.ws2a, f.p2a, 1, f.owner2);
}, 60_000);

afterAll(async () => {
  await t?.destroy();
});

describe('projects/tasks RLS', () => {
  it('no context sees nothing', async () => {
    await withContext(t.db, {}, async (trx) => {
      for (const tbl of ['projects', 'milestones', 'tasks', 'taskDependencies', 'comments', 'activityEvents'] as const) {
        expect(await trx.selectFrom(tbl).selectAll().execute()).toHaveLength(0);
      }
    });
  });

  it('org owner sees every workspace in own org, none from other orgs', async () => {
    await withContext(t.db, { userId: f.owner1, orgId: f.org1 }, async (trx) => {
      const ps = await trx.selectFrom('projects').select('id').execute();
      expect(ps.map((p) => p.id).sort()).toEqual([f.p1a, f.p1b].sort());
      const ts = await trx.selectFrom('tasks').select('id').execute();
      expect(ts.map((x) => x.id).sort()).toEqual([f.t1a, f.t1b].sort());
    });
  });

  it('non-admin sees only workspaces they belong to', async () => {
    await withContext(t.db, { userId: f.dev1, orgId: f.org1 }, async (trx) => {
      expect((await trx.selectFrom('projects').select('id').execute()).map((p) => p.id)).toEqual([f.p1a]);
      expect((await trx.selectFrom('tasks').select('id').execute()).map((p) => p.id)).toEqual([f.t1a]);
    });
  });

  it('cannot write into an invisible workspace or another org', async () => {
    await expect(
      withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) =>
        trx.insertInto('projects').values({ organizationId: f.org1, workspaceId: f.ws1b, key: 'ZZZ', name: 'x', createdBy: f.dev1 }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withContext(t.db, { userId: f.owner1, orgId: f.org1 }, (trx) =>
        trx.insertInto('projects').values({ organizationId: f.org2, workspaceId: f.ws2a, key: 'ZZZ', name: 'x', createdBy: f.owner1 }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // update of an invisible row affects nothing
    const r = await withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) =>
      trx.updateTable('tasks').set({ title: 'hacked' }).where('id', '=', f.t1b).executeTakeFirst(),
    );
    expect(Number(r.numUpdatedRows)).toBe(0);
  });

  it('composite FKs reject cross-workspace and cross-project links', async () => {
    // task in ws1a pointing at project of ws1b
    await expect(
      t.admin.insertInto('tasks').values({ organizationId: f.org1, workspaceId: f.ws1a, projectId: f.p1b, number: 9, title: 'x', reporterId: f.owner1 }).execute(),
    ).rejects.toThrow(/foreign key/);
    // dependency between tasks of different workspaces
    await expect(
      t.admin.insertInto('taskDependencies').values({ organizationId: f.org1, workspaceId: f.ws1a, taskId: f.t1a, dependsOnTaskId: f.t1b, createdBy: f.owner1 }).execute(),
    ).rejects.toThrow(/foreign key/);
    // assignee from another org
    await expect(
      t.admin.insertInto('tasks').values({ organizationId: f.org1, workspaceId: f.ws1a, projectId: f.p1a, number: 8, title: 'x', reporterId: f.owner1, assigneeId: f.owner2 }).execute(),
    ).rejects.toThrow(/foreign key/);
  });

  it('self-dependency is rejected', async () => {
    await expect(
      t.admin.insertInto('taskDependencies').values({ organizationId: f.org1, workspaceId: f.ws1a, taskId: f.t1a, dependsOnTaskId: f.t1a, createdBy: f.owner1 }).execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it('activity_events is append-only for everyone', async () => {
    await withContext(t.db, { userId: f.owner1, orgId: f.org1 }, (trx) =>
      trx.insertInto('activityEvents').values({ organizationId: f.org1, workspaceId: f.ws1a, projectId: f.p1a, action: 'x', actorId: f.owner1 }).execute(),
    );
    await expect(
      t.admin.updateTable('activityEvents').set({ action: 'y' }).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      withContext(t.db, { userId: f.owner1, orgId: f.org1 }, (trx) => trx.deleteFrom('activityEvents').execute()),
    ).rejects.toThrow();
  });
});
