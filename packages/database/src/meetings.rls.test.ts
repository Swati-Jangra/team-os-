import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, sql, withContext, type TestDatabase } from './index';

let t: TestDatabase;
const f = {} as Record<string, string>;

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const mkUser = async (e: string) => (await a.insertInto('users').values({ email: e, name: e, passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.owner = await mkUser('owner@m.com');
  f.dev1 = await mkUser('dev1@m.com');
  f.dev2 = await mkUser('dev2@m.com');
  f.out = await mkUser('out@m.com');
  const mkOrg = async (n: string, o: string) => (await a.insertInto('organizations').values({ name: n, slug: n, createdBy: o }).returning('id').executeTakeFirstOrThrow()).id;
  f.org1 = await mkOrg('m1', f.owner);
  f.org2 = await mkOrg('m2', f.out);
  await a.insertInto('organizationMembers').values([
    { organizationId: f.org1, userId: f.owner, role: 'OWNER' }, { organizationId: f.org1, userId: f.dev1, role: 'DEVELOPER' },
    { organizationId: f.org1, userId: f.dev2, role: 'DEVELOPER' }, { organizationId: f.org2, userId: f.out, role: 'OWNER' },
  ]).execute();
  const mkWs = async (org: string, n: string) => (await a.insertInto('workspaces').values({ organizationId: org, name: n, slug: n }).returning('id').executeTakeFirstOrThrow()).id;
  f.ws1 = await mkWs(f.org1, 'w1'); f.ws2 = await mkWs(f.org1, 'w2');
  await a.insertInto('workspaceMembers').values([
    { organizationId: f.org1, workspaceId: f.ws1, userId: f.dev1, role: 'DEVELOPER' }, { organizationId: f.org1, workspaceId: f.ws2, userId: f.dev2, role: 'DEVELOPER' },
  ]).execute();
  f.proj = (await a.insertInto('projects').values({ organizationId: f.org1, workspaceId: f.ws1, key: 'MT', name: 'p', createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  const mk = async (ws: string, title: string) => (await a.insertInto('meetings').values({ organizationId: f.org1, workspaceId: ws, title, createdBy: f.owner, transcript: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.m1 = await mk(f.ws1, 'Sprint planning');
  f.m2 = await mk(f.ws2, 'Finance sync');
}, 60_000);
afterAll(async () => t?.destroy());

const item = (meeting: string, ws: string, extra: object = {}) => ({ organizationId: f.org1, workspaceId: ws, meetingId: meeting, kind: 'ACTION_ITEM' as const, text: 'Do the thing', ...extra });

describe('meetings RLS', () => {
  it('only shows meetings in workspaces the user can see', async () => {
    const titles = (ctx: { userId: string; orgId: string }) => withContext(t.db, ctx, (trx) => trx.selectFrom('meetings').select('title').orderBy('title').execute()).then((r) => r.map((x) => x.title));
    expect(await titles({ userId: f.dev1, orgId: f.org1 })).toEqual(['Sprint planning']);
    expect(await titles({ userId: f.dev2, orgId: f.org1 })).toEqual(['Finance sync']);
    expect(await titles({ userId: f.owner, orgId: f.org1 })).toEqual(['Finance sync', 'Sprint planning']);
    expect(await titles({ userId: f.out, orgId: f.org2 })).toEqual([]);
    expect(await titles({ userId: f.out, orgId: f.org1 })).toEqual([]);
  });

  it('a user cannot create meetings/items in a workspace they cannot see; project must be in the same workspace', async () => {
    await expect(withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) =>
      trx.insertInto('meetings').values({ organizationId: f.org1, workspaceId: f.ws2, title: 'x', createdBy: f.dev1 }).execute())).rejects.toThrow(/row-level security/);
    await expect(t.admin.insertInto('meetings').values({ organizationId: f.org1, workspaceId: f.ws2, projectId: f.proj, title: 'x', createdBy: f.owner }).execute()).rejects.toThrow(/foreign key/);
    await expect(withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) => trx.insertInto('meetingItems').values(item(f.m2, f.ws2)).execute())).rejects.toThrow(/row-level security|foreign key/);
  });

  it('the processing worker (org context, no user) can write results inside its org only', async () => {
    await withContext(t.db, { orgId: f.org1 }, async (trx) => {
      await trx.insertInto('meetingItems').values([item(f.m1, f.ws1), item(f.m1, f.ws1, { kind: 'DECISION', text: 'Ship Friday' })]).execute();
      await trx.updateTable('meetings').set({ status: 'READY', summary: 'ok' }).where('id', '=', f.m1).execute();
    });
    expect((await t.admin.selectFrom('meetings').select('status').where('id', '=', f.m1).executeTakeFirstOrThrow()).status).toBe('READY');
    // another org's worker context can neither see nor change them
    const upd = await withContext(t.db, { orgId: f.org2 }, (trx) => trx.updateTable('meetings').set({ summary: 'hax' }).where('id', '=', f.m1).executeTakeFirst());
    expect(Number(upd.numUpdatedRows)).toBe(0);
    // a signed-in user in a wrong-org context sees nothing (system policy requires NO user)
    expect(await withContext(t.db, { userId: f.out, orgId: f.org1 }, (trx) => trx.selectFrom('meetingItems').select('id').execute())).toEqual([]);
  });

  it('decided items are immutable records: no re-decision, no deletion; pending can be replaced', async () => {
    const ids = await t.admin.selectFrom('meetingItems').select(['id', 'kind']).where('meetingId', '=', f.m1).execute();
    const action = ids.find((i) => i.kind === 'ACTION_ITEM')!.id;
    await withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) => trx.updateTable('meetingItems').set({ status: 'REJECTED', decidedBy: f.dev1, decidedAt: new Date() }).where('id', '=', action).execute());
    await expect(withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) => trx.updateTable('meetingItems').set({ status: 'APPROVED' }).where('id', '=', action).execute())).rejects.toThrow(/cannot change its decision/);
    await expect(withContext(t.db, { orgId: f.org1 }, (trx) => trx.deleteFrom('meetingItems').where('id', '=', action).execute())).rejects.toThrow(/cannot be deleted/);
    // still-pending items can be deleted (reprocessing)
    const del = await withContext(t.db, { orgId: f.org1 }, (trx) => trx.deleteFrom('meetingItems').where('meetingId', '=', f.m1).where('status', '=', 'PENDING').executeTakeFirst());
    expect(Number(del.numDeletedRows)).toBe(1);
  });

  it('only an approved ACTION_ITEM may link a task, and the task must be in the same workspace', async () => {
    const task = (await t.admin.insertInto('tasks').values({ organizationId: f.org1, workspaceId: f.ws1, projectId: f.proj, number: 1, title: 't', reporterId: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
    await expect(t.admin.insertInto('meetingItems').values(item(f.m1, f.ws1, { taskId: task })).execute()).rejects.toThrow(/check constraint/);
    await expect(t.admin.insertInto('meetingItems').values(item(f.m1, f.ws1, { kind: 'DECISION', status: 'APPROVED', taskId: task })).execute()).rejects.toThrow(/check constraint/);
    await t.admin.insertInto('meetingItems').values(item(f.m1, f.ws1, { status: 'APPROVED', taskId: task })).execute();
  });

  it('search hides transcripts of deleted or unprocessed meetings, and the worker helper reflects live state', async () => {
    const mk = (title: string, status: string) => t.admin.insertInto('meetings').values({ organizationId: f.org1, workspaceId: f.ws1, title, createdBy: f.owner, status: status as 'READY', transcript: 'x' }).returning('id').executeTakeFirstOrThrow().then((r) => r.id);
    const ready = await mk('Ready one', 'READY');
    const gone = await mk('Gone one', 'READY');
    const proc = await mk('Proc one', 'PROCESSING');
    for (const [id, title] of [[ready, 'Ready one'], [gone, 'Gone one'], [proc, 'Proc one']] as const) {
      await withContext(t.db, { orgId: f.org1 }, (trx) => trx.insertInto('knowledgeChunks').values({
        organizationId: f.org1, workspaceId: f.ws1, sourceType: 'MEETING', sourceId: id, chunkIndex: 0, sourceTitle: title, content: 'zebra budget discussion',
        embedding: [1, 0], embeddingModel: 'm', embeddingVersion: '1', sourceVersion: 1 }).execute());
    }
    await t.admin.updateTable('meetings').set({ deletedAt: new Date() }).where('id', '=', gone).execute();
    const r = await withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) =>
      sql<{ sourceTitle: string }>`SELECT source_title FROM knowledge_search('zebra', ARRAY[1,0]::real[], 'm', '1', NULL, 10)`.execute(trx));
    expect(r.rows.map((x) => x.sourceTitle)).toEqual(['Ready one']);
    const st = await withContext(t.db, { orgId: f.org1 }, (trx) => sql<{ deleted: boolean; status: string }>`SELECT * FROM job_meeting_state(${gone}::uuid)`.execute(trx));
    expect(st.rows[0]).toMatchObject({ deleted: true });
  });
});
