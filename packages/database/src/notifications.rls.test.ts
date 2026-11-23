import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, sql, withContext, type TestDatabase } from './index';

let t: TestDatabase;
const f = {} as Record<string, string>;

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const mkUser = async (e: string) =>
    (await a.insertInto('users').values({ email: e, name: e, passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.u1 = await mkUser('u1@x.com');
  f.u2 = await mkUser('u2@x.com');
  f.u3 = await mkUser('u3@x.com'); // other org
  const mkOrg = async (n: string, owner: string) =>
    (await a.insertInto('organizations').values({ name: n, slug: n, createdBy: owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.org1 = await mkOrg('o1', f.u1);
  f.org2 = await mkOrg('o2', f.u3);
  await a.insertInto('organizationMembers').values([
    { organizationId: f.org1, userId: f.u1, role: 'OWNER' },
    { organizationId: f.org1, userId: f.u2, role: 'DEVELOPER' },
    { organizationId: f.org2, userId: f.u3, role: 'OWNER' },
  ]).execute();
  f.ws = (await a.insertInto('workspaces').values({ organizationId: f.org1, name: 'w', slug: 'w' }).returning('id').executeTakeFirstOrThrow()).id;
  f.proj = (await a.insertInto('projects').values({ organizationId: f.org1, workspaceId: f.ws, key: 'AB', name: 'p', createdBy: f.u1 }).returning('id').executeTakeFirstOrThrow()).id;
}, 60_000);
afterAll(async () => t?.destroy());

const note = (user: string, org: string, extra: object = {}) => ({
  organizationId: org, userId: user, category: 'TASK_ASSIGNED' as const, title: 'hello', ...extra,
});

describe('notifications RLS', () => {
  it('a worker (org context only) can create notifications for org members, and only they can read them', async () => {
    await withContext(t.db, { orgId: f.org1 }, (trx) =>
      trx.insertInto('notifications').values([note(f.u1, f.org1), note(f.u2, f.org1, { title: 'for u2' })]).execute(),
    );
    const own = await withContext(t.db, { userId: f.u2, orgId: f.org1 }, (trx) => trx.selectFrom('notifications').select('title').execute());
    expect(own.map((n) => n.title)).toEqual(['for u2']);
    // no user context => nothing
    expect(await withContext(t.db, { orgId: f.org1 }, (trx) => trx.selectFrom('notifications').selectAll().execute())).toHaveLength(0);
    // other org user => nothing
    expect(await withContext(t.db, { userId: f.u3, orgId: f.org2 }, (trx) => trx.selectFrom('notifications').selectAll().execute())).toHaveLength(0);
    // same user but wrong org context => nothing
    expect(await withContext(t.db, { userId: f.u2, orgId: f.org2 }, (trx) => trx.selectFrom('notifications').selectAll().execute())).toHaveLength(0);
  });

  it('cannot notify someone outside the org or write into another org', async () => {
    await expect(
      withContext(t.db, { orgId: f.org1 }, (trx) => trx.insertInto('notifications').values(note(f.u3, f.org1)).execute()),
    ).rejects.toThrow(/foreign key/);
    await expect(
      withContext(t.db, { orgId: f.org1 }, (trx) => trx.insertInto('notifications').values(note(f.u3, f.org2)).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it('users can mark only their own as read', async () => {
    const mine = await withContext(t.db, { userId: f.u2, orgId: f.org1 }, (trx) =>
      trx.updateTable('notifications').set({ readAt: new Date() }).executeTakeFirst());
    expect(Number(mine.numUpdatedRows)).toBe(1);
    const u1 = await t.admin.selectFrom('notifications').select('readAt').where('userId', '=', f.u1).executeTakeFirstOrThrow();
    expect(u1.readAt).toBeNull();
  });

  it('dedupe keys make scheduled inserts idempotent', async () => {
    // ON CONFLICT also evaluates the SELECT policy on the new row, so jobs insert per recipient (user + org context)
    const ins = () => withContext(t.db, { userId: f.u1, orgId: f.org1 }, (trx) =>
      trx.insertInto('notifications').values(note(f.u1, f.org1, { dedupeKey: 'due:x' })).onConflict((oc) => oc.columns(['userId', 'dedupeKey']).doNothing()).executeTakeFirst());
    expect(Number((await ins()).numInsertedOrUpdatedRows)).toBe(1);
    expect(Number((await ins()).numInsertedOrUpdatedRows)).toBe(0);
  });

  it('preferences are private to the user', async () => {
    await withContext(t.db, { userId: f.u1 }, (trx) =>
      trx.insertInto('notificationPreferences').values({ userId: f.u1, category: 'TASK_DUE', inApp: true, email: true }).execute());
    expect(await withContext(t.db, { userId: f.u2 }, (trx) => trx.selectFrom('notificationPreferences').selectAll().execute())).toHaveLength(0);
    await expect(
      withContext(t.db, { userId: f.u2 }, (trx) => trx.insertInto('notificationPreferences').values({ userId: f.u1, category: 'TASK_STATUS', inApp: false, email: false }).execute()),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('job helpers', () => {
  it('job_task_context / commenters / due_soon work without a user session and ignore deleted tasks', async () => {
    const a = t.admin;
    const task = (await a.insertInto('tasks').values({
      organizationId: f.org1, workspaceId: f.ws, projectId: f.proj, number: 1, title: 'Due', reporterId: f.u1, assigneeId: f.u2, dueDate: '2026-06-10',
    }).returning('id').executeTakeFirstOrThrow()).id;
    await a.insertInto('comments').values({ organizationId: f.org1, workspaceId: f.ws, taskId: task, authorId: f.u1, body: 'hi' }).execute();

    const ctx = await withContext(t.db, {}, (trx) => sql<{ identifier: string; assigneeId: string }>`SELECT * FROM job_task_context(${task}::uuid)`.execute(trx));
    expect(ctx.rows[0]?.identifier).toBe('AB-1');
    const com = await withContext(t.db, {}, (trx) => sql<{ userId: string }>`SELECT * FROM job_task_commenters(${task}::uuid)`.execute(trx));
    expect(com.rows.map((r) => r.userId)).toEqual([f.u1]);

    const due = (day: string) => withContext(t.db, {}, (trx) => sql<{ taskId: string }>`SELECT * FROM job_tasks_due_soon(${day}::date)`.execute(trx));
    expect((await due('2026-06-09')).rows).toHaveLength(1); // due tomorrow
    expect((await due('2026-06-10')).rows).toHaveLength(1); // due today
    expect((await due('2026-06-15')).rows).toHaveLength(1); // 5 days overdue
    expect((await due('2026-06-30')).rows).toHaveLength(0); // too old
    expect((await due('2026-06-01')).rows).toHaveLength(0); // not yet due

    await a.updateTable('tasks').set({ status: 'DONE' }).where('id', '=', task).execute();
    expect((await due('2026-06-10')).rows).toHaveLength(0);
    await a.updateTable('tasks').set({ deletedAt: new Date() }).where('id', '=', task).execute();
    expect((await withContext(t.db, {}, (trx) => sql`SELECT * FROM job_task_context(${task}::uuid)`.execute(trx))).rows).toHaveLength(0);
  });

  it('job_cleanup removes only stale rows', async () => {
    const a = t.admin;
    await a.insertInto('sessions').values([
      { userId: f.u1, tokenHash: 'old', csrfToken: 'x', expiresAt: new Date(Date.now() - 5 * 86_400_000) },
      { userId: f.u1, tokenHash: 'live', csrfToken: 'x', expiresAt: new Date(Date.now() + 86_400_000) },
    ]).execute();
    const r = await withContext(t.db, {}, (trx) => sql<{ step: string; removed: number }>`SELECT * FROM job_cleanup(now())`.execute(trx));
    expect(r.rows.find((x) => x.step === 'sessions')?.removed).toBe(1);
    const left = await a.selectFrom('sessions').select('tokenHash').execute();
    expect(left.map((s) => s.tokenHash)).toEqual(['live']);
  });
});
