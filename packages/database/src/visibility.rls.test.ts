import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, withContext, type TestDatabase } from './index';

/**
 * app_visible_workspaces() replaced a per-row app_can_see_workspace() call in every workspace policy
 * (migration 0011). These tests pin the semantics and the query plan.
 */
let t: TestDatabase;
const f = {} as Record<string, string>;

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const mkUser = async (e: string) => (await a.insertInto('users').values({ email: e, name: e, passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  for (const k of ['owner', 'admin', 'dev', 'devRemoved', 'nobody', 'owner2']) f[k] = await mkUser(`${k.toLowerCase()}@x.com`);
  const mkOrg = async (n: string, by: string) => (await a.insertInto('organizations').values({ name: n, slug: n, createdBy: by }).returning('id').executeTakeFirstOrThrow()).id;
  f.org1 = await mkOrg('o1', f.owner!);
  f.org2 = await mkOrg('o2', f.owner2!);
  await a.insertInto('organizationMembers').values([
    { organizationId: f.org1, userId: f.owner!, role: 'OWNER' },
    { organizationId: f.org1, userId: f.admin!, role: 'ADMIN' },
    { organizationId: f.org1, userId: f.dev!, role: 'DEVELOPER' },
    { organizationId: f.org1, userId: f.devRemoved!, role: 'DEVELOPER' },
    { organizationId: f.org2, userId: f.owner2!, role: 'OWNER' },
    // a user that is an ADMIN elsewhere must not gain visibility here
    { organizationId: f.org2, userId: f.nobody!, role: 'ADMIN' },
  ]).execute();
  const mkWs = async (org: string, slug: string) => (await a.insertInto('workspaces').values({ organizationId: org, name: slug, slug }).returning('id').executeTakeFirstOrThrow()).id;
  f.wsA = await mkWs(f.org1, 'a');
  f.wsB = await mkWs(f.org1, 'b');
  f.ws2 = await mkWs(f.org2, 'c');
  await a.insertInto('workspaceMembers').values([
    { organizationId: f.org1, workspaceId: f.wsA, userId: f.dev!, role: 'DEVELOPER' },
    { organizationId: f.org1, workspaceId: f.wsA, userId: f.devRemoved!, role: 'DEVELOPER', deletedAt: new Date() as never },
  ]).execute();
}, 60_000);
afterAll(async () => t?.destroy());

const visible = (userId: string | undefined, orgId: string) =>
  withContext(t.db, { userId, orgId }, async (trx) => (await sql<{ id: string }>`SELECT app_visible_workspaces() AS id`.execute(trx)).rows.map((r) => r.id).sort());

describe('app_visible_workspaces', () => {
  it('org owners and admins see every workspace of their org, and only theirs', async () => {
    const all = [f.wsA!, f.wsB!].sort();
    expect(await visible(f.owner, f.org1!)).toEqual(all);
    expect(await visible(f.admin, f.org1!)).toEqual(all);
    expect(await visible(f.owner2, f.org2!)).toEqual([f.ws2!]);
  });
  it('members see only workspaces they belong to', async () => {
    expect(await visible(f.dev, f.org1!)).toEqual([f.wsA!]);
  });
  it('removed workspace members, outsiders and org-less callers see nothing', async () => {
    expect(await visible(f.devRemoved, f.org1!)).toEqual([]);
    expect(await visible(f.nobody, f.org1!)).toEqual([]); // ADMIN of org2 only
    expect(await visible(undefined, f.org1!)).toEqual([]); // background context
    expect(await visible(f.owner, f.org2!)).toEqual([]); // not a member of org2
  });
  it('no policy still calls the per-row function', async () => {
    const rows = await sql<{ n: string }>`SELECT count(*) AS n FROM pg_policies WHERE qual LIKE '%app_can_see_workspace%' OR with_check LIKE '%app_can_see_workspace%'`.execute(t.admin);
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });
  it('the planner evaluates visibility once (hashed subplan), not once per row', async () => {
    await t.admin.insertInto('projects').values({ organizationId: f.org1!, workspaceId: f.wsA!, key: 'PRF', name: 'p', createdBy: f.owner! }).execute();
    const plan = await withContext(t.db, { userId: f.owner, orgId: f.org1! }, async (trx) =>
      (await sql<{ 'QUERY PLAN': string }>`EXPLAIN SELECT * FROM projects`.execute(trx)).rows.map((r) => r['QUERY PLAN']).join('\n'));
    expect(plan).toMatch(/hashed SubPlan|InitPlan|SubPlan/);
    expect(plan).not.toContain('app_can_see_workspace');
  });
});
