import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, sql, withContext, type TestDatabase } from './index';

let t: TestDatabase;
const f = {} as Record<string, string>;

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const mkUser = async (e: string) => (await a.insertInto('users').values({ email: e, name: e, passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.owner = await mkUser('o@g.com'); f.dev1 = await mkUser('d1@g.com'); f.dev2 = await mkUser('d2@g.com');
  f.org = (await a.insertInto('organizations').values({ name: 'g', slug: 'g', createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.org2 = (await a.insertInto('organizations').values({ name: 'g2', slug: 'g2', createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('organizationMembers').values([{ organizationId: f.org, userId: f.owner, role: 'OWNER' }, { organizationId: f.org, userId: f.dev1, role: 'DEVELOPER' }, { organizationId: f.org, userId: f.dev2, role: 'DEVELOPER' }]).execute();
  const mkWs = async (n: string) => (await a.insertInto('workspaces').values({ organizationId: f.org, name: n, slug: n }).returning('id').executeTakeFirstOrThrow()).id;
  f.ws1 = await mkWs('w1'); f.ws2 = await mkWs('w2');
  await a.insertInto('workspaceMembers').values([{ organizationId: f.org, workspaceId: f.ws1, userId: f.dev1, role: 'DEVELOPER' }, { organizationId: f.org, workspaceId: f.ws2, userId: f.dev2, role: 'DEVELOPER' }]).execute();
  f.p1 = (await a.insertInto('projects').values({ organizationId: f.org, workspaceId: f.ws1, key: 'AA', name: 'AA', createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.p2 = (await a.insertInto('projects').values({ organizationId: f.org, workspaceId: f.ws2, key: 'BB', name: 'BB', createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  const integ = async (provider: 'GOOGLE_CALENDAR' | 'GOOGLE_MAIL') => (await a.insertInto('integrations').values({ organizationId: f.org, provider, accountLogin: 'me@x.com', accountId: 'me@x.com', connectedBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.ic = await integ('GOOGLE_CALENDAR'); f.im = await integ('GOOGLE_MAIL');
  const cal = (ws: string, id: string) => a.insertInto('calendarSources').values({ organizationId: f.org, integrationId: f.ic, workspaceId: ws, calendarId: id, name: id }).returning('id').executeTakeFirstOrThrow().then((r) => r.id);
  f.c1 = await cal(f.ws1, 'cal-1'); f.c2 = await cal(f.ws2, 'cal-2');
  const ev = (ws: string, src: string, id: string) => a.insertInto('calendarEvents').values({ organizationId: f.org, workspaceId: ws, sourceId: src, externalId: id, title: 'Standup', startsAt: new Date(), endsAt: new Date(Date.now() + 36e5) }).returning('id').executeTakeFirstOrThrow().then((r) => r.id);
  f.e1 = await ev(f.ws1, f.c1, 'e1'); f.e2 = await ev(f.ws2, f.c2, 'e2');
  f.es = (await a.insertInto('emailSources').values({ organizationId: f.org, integrationId: f.im, workspaceId: f.ws1, label: 'TeamOS' }).returning('id').executeTakeFirstOrThrow()).id;
  f.m1 = (await a.insertInto('emailMessages').values({ organizationId: f.org, workspaceId: f.ws1, sourceId: f.es, externalId: 'g1', subject: 'Hi', receivedAt: new Date(), excerpt: 'body' }).returning('id').executeTakeFirstOrThrow()).id;
}, 60_000);
afterAll(async () => t?.destroy());

const as = <T>(userId: string | undefined, orgId: string, fn: Parameters<typeof withContext<T>>[2]) => withContext(t.db, userId ? { userId, orgId } : { orgId }, fn);

describe('calendar', () => {
  it('events follow workspace visibility and are read-only for users; sources are admin-only', async () => {
    const ids = (u: string) => as(u, f.org, (trx) => trx.selectFrom('calendarEvents').select('id').execute()).then((r) => r.map((x) => x.id));
    expect(await ids(f.dev1)).toEqual([f.e1]);
    expect(await ids(f.dev2)).toEqual([f.e2]);
    expect(await ids(f.owner)).toHaveLength(2);
    await expect(as(f.dev1, f.org, (trx) => trx.updateTable('calendarEvents').set({ title: 'hacked' }).where('id', '=', f.e1).execute())).resolves.toBeDefined();
    expect((await t.admin.selectFrom('calendarEvents').select('title').where('id', '=', f.e1).executeTakeFirstOrThrow()).title).toBe('Standup'); // 0 rows matched: no UPDATE policy for users
    await expect(as(f.dev1, f.org, (trx) => trx.insertInto('calendarEvents').values({ organizationId: f.org, workspaceId: f.ws1, sourceId: f.c1, externalId: 'x', title: 'x', startsAt: new Date(), endsAt: new Date() }).execute())).rejects.toThrow();
    expect(await as(f.dev1, f.org, (trx) => trx.selectFrom('calendarSources').select('id').execute())).toEqual([]);
    expect(await as(f.owner, f.org, (trx) => trx.selectFrom('calendarSources').select('id').execute())).toHaveLength(2);
  });

  it('one calendar belongs to one organization-wide source; an event cannot point at another workspace\'s source', async () => {
    await expect(t.admin.insertInto('calendarSources').values({ organizationId: f.org, integrationId: f.ic, workspaceId: f.ws2, calendarId: 'cal-1', name: 'dup' }).execute()).rejects.toThrow();
    await expect(t.admin.insertInto('calendarEvents').values({ organizationId: f.org, workspaceId: f.ws2, sourceId: f.c1, externalId: 'z', title: 'z', startsAt: new Date(), endsAt: new Date() }).execute()).rejects.toThrow();
  });

  it('meeting links stay within one workspace and are one-to-one', async () => {
    const mt = async (ws: string) => (await t.admin.insertInto('meetings').values({ organizationId: f.org, workspaceId: ws, title: 'M', createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
    const m1 = await mt(f.ws1), m1b = await mt(f.ws1), m2 = await mt(f.ws2);
    await expect(as(f.dev1, f.org, (trx) => trx.insertInto('meetingCalendarLinks').values({ organizationId: f.org, workspaceId: f.ws1, meetingId: m1, eventId: f.e2, createdBy: f.dev1 }).execute())).rejects.toThrow(); // event of ws2
    await expect(as(f.dev1, f.org, (trx) => trx.insertInto('meetingCalendarLinks').values({ organizationId: f.org, workspaceId: f.ws1, meetingId: m2, eventId: f.e1, createdBy: f.dev1 }).execute())).rejects.toThrow(); // meeting of ws2
    await as(f.dev1, f.org, (trx) => trx.insertInto('meetingCalendarLinks').values({ organizationId: f.org, workspaceId: f.ws1, meetingId: m1, eventId: f.e1, createdBy: f.dev1 }).execute());
    await expect(as(f.dev1, f.org, (trx) => trx.insertInto('meetingCalendarLinks').values({ organizationId: f.org, workspaceId: f.ws1, meetingId: m1b, eventId: f.e1, createdBy: f.dev1 }).execute())).rejects.toThrow(); // event already linked
    expect(await as(f.dev2, f.org, (trx) => trx.selectFrom('meetingCalendarLinks').select('id').execute())).toEqual([]);
  });

  it('scheduler function lists only connected, active sources; the worker context cannot read other orgs', async () => {
    expect((await withContext(t.db, {}, (trx) => sql<{ sourceId: string }>`SELECT source_id AS "sourceId" FROM job_sync_calendars()`.execute(trx))).rows.map((r) => r.sourceId).sort()).toEqual([f.c1, f.c2].sort());
    await t.admin.updateTable('integrations').set({ status: 'DISCONNECTED' }).where('id', '=', f.ic).execute();
    expect((await withContext(t.db, {}, (trx) => sql`SELECT source_id FROM job_sync_calendars()`.execute(trx))).rows).toHaveLength(0);
    await t.admin.updateTable('integrations').set({ status: 'CONNECTED' }).where('id', '=', f.ic).execute();
    expect(await as(undefined, f.org2, (trx) => trx.selectFrom('calendarEvents').select('id').execute())).toEqual([]);
  });
});

describe('email', () => {
  it('messages follow workspace visibility; users may only change the project link', async () => {
    expect(await as(f.dev2, f.org, (trx) => trx.selectFrom('emailMessages').select('id').execute())).toEqual([]);
    expect(await as(f.dev1, f.org, (trx) => trx.selectFrom('emailMessages').select('id').execute())).toHaveLength(1);
    await as(f.dev1, f.org, (trx) => trx.updateTable('emailMessages').set({ projectId: f.p1, linkSource: 'MANUAL' }).where('id', '=', f.m1).execute());
    await expect(as(f.dev1, f.org, (trx) => trx.updateTable('emailMessages').set({ projectId: f.p2, linkSource: 'MANUAL' }).where('id', '=', f.m1).execute())).rejects.toThrow(); // project of another workspace
    await expect(as(f.dev1, f.org, (trx) => trx.deleteFrom('emailMessages').where('id', '=', f.m1).execute())).rejects.toThrow(); // no DELETE privilege
  });

  it('project and link source go together', async () => {
    await expect(t.admin.updateTable('emailMessages').set({ projectId: f.p1, linkSource: null }).where('id', '=', f.m1).execute()).rejects.toThrow();
  });

  it('decided items are permanent and cannot change their decision', async () => {
    const it1 = (await t.admin.insertInto('emailItems').values({ organizationId: f.org, workspaceId: f.ws1, messageId: f.m1, kind: 'DECISION', text: 'Ship Friday' }).returning('id').executeTakeFirstOrThrow()).id;
    await as(f.dev1, f.org, (trx) => trx.updateTable('emailItems').set({ status: 'APPROVED', decidedBy: f.dev1, decidedAt: new Date() }).where('id', '=', it1).execute());
    await expect(as(f.dev1, f.org, (trx) => trx.updateTable('emailItems').set({ status: 'REJECTED' }).where('id', '=', it1).execute())).rejects.toThrow(/cannot change/);
    await expect(as(f.dev1, f.org, (trx) => trx.deleteFrom('emailItems').where('id', '=', it1).execute())).rejects.toThrow(/cannot be deleted/);
    await expect(t.admin.insertInto('emailItems').values({ organizationId: f.org, workspaceId: f.ws1, messageId: f.m1, kind: 'DECISION', text: 'x', status: 'APPROVED', taskId: null }).execute()).resolves.toBeDefined();
  });

  it('a task can only be attached to an approved action item, and items of other workspaces are invisible', async () => {
    const task = (await t.admin.insertInto('tasks').values({ organizationId: f.org, workspaceId: f.ws1, projectId: f.p1, number: 1, title: 't', reporterId: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
    await expect(t.admin.insertInto('emailItems').values({ organizationId: f.org, workspaceId: f.ws1, messageId: f.m1, kind: 'DECISION', text: 'x', taskId: task, status: 'APPROVED' }).execute()).rejects.toThrow();
    expect(await as(f.dev2, f.org, (trx) => trx.selectFrom('emailItems').select('id').execute())).toEqual([]);
  });

  it('mailbox sources are admin-only; a developer cannot see them', async () => {
    expect(await as(f.dev1, f.org, (trx) => trx.selectFrom('emailSources').select('id').execute())).toEqual([]);
    expect(await as(f.owner, f.org, (trx) => trx.selectFrom('emailSources').select('id').execute())).toHaveLength(1);
  });

  it('job_find_project resolves a key only inside one organization and workspace', async () => {
    const q = (org: string, ws: string, key: string) => withContext(t.db, { orgId: org }, (trx) => sql<{ id: string | null }>`SELECT job_find_project(${org}::uuid, ${ws}::uuid, ${key}) AS id`.execute(trx)).then((r) => r.rows[0]!.id);
    expect(await q(f.org, f.ws1, 'AA')).toBe(f.p1);
    expect(await q(f.org, f.ws1, 'BB')).toBeNull();
    expect(await q(f.org2, f.ws1, 'AA')).toBeNull();
  });
});
