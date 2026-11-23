import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOGLE_SCOPES, GoogleClient } from '@teamos/integrations';
import { createHarness, type Client, type Harness } from './harness';

const CAL = GOOGLE_SCOPES.calendar[0];
const MAIL = GOOGLE_SCOPES.mail[0];
/** Google stand-in behind the REAL GoogleClient (injected fetch). */
function fakeGoogle() {
  const st = { revoked: [] as string[], calendars: [{ id: 'me@x.com', summary: 'Me', primary: true }, { id: 'team@x.com', summary: 'Team' }], refreshFails: false };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.host === 'tok.test' && u.pathname === '/token') {
      const b = new URLSearchParams(String(init.body));
      if (b.get('grant_type') === 'refresh_token') return st.refreshFails ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'refreshed', expires_in: 3600 });
      const code = b.get('code');
      if (code === 'cal') return json({ access_token: 'at-cal', refresh_token: 'rt-cal', expires_in: 3600, scope: CAL });
      if (code === 'mail') return json({ access_token: 'at-mail', refresh_token: 'rt-mail', expires_in: 3600, scope: MAIL });
      if (code === 'narrow') return json({ access_token: 'x', refresh_token: 'y', expires_in: 3600, scope: 'openid' });
      if (code === 'norefresh') return json({ access_token: 'x', expires_in: 3600, scope: CAL });
      return json({ error: 'invalid_grant' }, 400);
    }
    if (u.pathname === '/revoke') { st.revoked.push(new URLSearchParams(String(init.body)).get('token')!); return json({}); }
    if (u.host === 'cal.test' && u.pathname.endsWith('/calendarList')) return json({ items: st.calendars });
    if (u.host === 'mail.test' && u.pathname.endsWith('/profile')) return json({ emailAddress: 'box@x.com' });
    return json({}, 404);
  }) as typeof fetch;
  const client = new GoogleClient({ clientId: 'cid', clientSecret: 'cs', authUrl: 'https://auth.test/o', tokenUrl: 'https://tok.test/token', revokeUrl: 'https://tok.test/revoke', calendarUrl: 'https://cal.test/v3', gmailUrl: 'https://mail.test/v1', fetch: f });
  return { client, st };
}

let h: Harness;
let g: ReturnType<typeof fakeGoogle>;
let owner: Client, pm: Client, dev: Client, dev2: Client, outsider: Client;
let org: string, ws1: string, ws2: string, proj1: string, proj1b: string, proj2: string;
const base = () => `/organizations/${org}`;
const overview = async (c: Client = owner) => (await c.get(`${base()}/google`)).body.data;

async function addMember(email: string, role: string, workspaceIds: string[]): Promise<Client> {
  const c = await h.signup(email);
  expect((await owner.post(`${base()}/invitations`, { email, role, workspaceIds })).status).toBe(201);
  expect((await c.post('/invitations/accept', { token: await h.tokenFor('member.invited.v1', email) })).status).toBe(200);
  return c;
}
async function connect(c: Client, kind: 'calendar' | 'mail', code: string) {
  const a = await c.post(`${base()}/google/${kind}/authorize`);
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  const state = new URL(a.body.data.url).searchParams.get('state')!;
  return { url: new URL(a.body.data.url), state, res: await c.get(`/integrations/google/callback?code=${code}&state=${state}`) };
}

beforeAll(async () => {
  g = fakeGoogle();
  h = await createHarness({ integrationKey: randomBytes(32) }, undefined, undefined, g.client);
  owner = await h.signup('owner@g.com', 'Owner');
  org = (await owner.post('/organizations', { name: 'Google Org' })).body.data.id;
  ws1 = (await owner.post(`${base()}/workspaces`, { name: 'Alpha' })).body.data.id;
  ws2 = (await owner.post(`${base()}/workspaces`, { name: 'Beta' })).body.data.id;
  proj1 = (await owner.post(`${base()}/projects`, { workspaceId: ws1, name: 'Apollo', key: 'APO' })).body.data.id;
  proj1b = (await owner.post(`${base()}/projects`, { workspaceId: ws1, name: 'Zeus', key: 'ZEU' })).body.data.id;
  proj2 = (await owner.post(`${base()}/projects`, { workspaceId: ws2, name: 'Beta', key: 'BET' })).body.data.id;
  pm = await addMember('pm@g.com', 'PROJECT_MANAGER', [ws1]);
  dev = await addMember('dev@g.com', 'DEVELOPER', [ws1]);
  dev2 = await addMember('dev2@g.com', 'DEVELOPER', [ws2]);
  outsider = await h.signup('out@g.com');
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('OAuth', () => {
  it('only integration managers can start a connection; members can see status', async () => {
    expect((await dev.post(`${base()}/google/calendar/authorize`)).status).toBe(403);
    expect((await outsider.post(`${base()}/google/mail/authorize`)).status).toBe(404);
    expect((await h.client().post(`${base()}/google/mail/authorize`)).status).toBe(401);
    expect((await dev.get(`${base()}/google`)).status).toBe(200);
    expect((await overview()).configured).toBe(true);
  });

  it('asks Google for ONLY the read-only scope of the chosen feature, offline', async () => {
    const a = await owner.post(`${base()}/google/calendar/authorize`);
    const u = new URL(a.body.data.url);
    expect(u.searchParams.get('scope')).toBe(CAL);
    expect(u.searchParams.get('access_type')).toBe('offline');
    const m = await owner.post(`${base()}/google/mail/authorize`);
    expect(new URL(m.body.data.url).searchParams.get('scope')).toBe(MAIL);
  });

  it('rejects unknown, foreign and replayed state', async () => {
    expect((await owner.get('/integrations/google/callback?code=cal&state=nope-nope-nope-nope')).status).toBe(400);
    const a = await owner.post(`${base()}/google/calendar/authorize`);
    const state = new URL(a.body.data.url).searchParams.get('state')!;
    expect((await pm.get(`/integrations/google/callback?code=cal&state=${state}`)).status).toBe(400); // another user
    expect((await owner.get(`/integrations/google/callback?code=cal&state=${state}`)).status).toBe(302); // still usable by its owner
    expect((await owner.get(`/integrations/google/callback?code=cal&state=${state}`)).status).toBe(400); // single use
  });

  it('refuses grants that cannot work: a narrowed scope or no refresh token connects nothing', async () => {
    await owner.delete(`${base()}/google/${(await overview()).calendar.integration.id}`);
    const narrow = await connect(owner, 'calendar', 'narrow');
    expect(narrow.res.status).toBe(302);
    expect(narrow.res.headers.location).toContain('error=google_scope_missing');
    const nr = await connect(owner, 'calendar', 'norefresh');
    expect(nr.res.headers.location).toContain('error=google_no_refresh_token');
    const denied = await owner.post(`${base()}/google/calendar/authorize`);
    const s = new URL(denied.body.data.url).searchParams.get('state')!;
    expect((await owner.get(`/integrations/google/callback?error=access_denied&state=${s}`)).headers.location).toContain('error=google_denied');
    expect((await overview()).calendar.integration).toBeNull();
    expect(await h.t.admin.selectFrom('integrationTokens').select('integrationId').execute()).toHaveLength(0);
  });

  it('connects calendar and mail separately; tokens (access + refresh) are encrypted and never returned', async () => {
    expect((await connect(owner, 'calendar', 'cal')).res.headers.location).toContain('connected=google');
    expect((await connect(owner, 'mail', 'mail')).res.headers.location).toContain('connected=google');
    const o = await overview();
    expect(o.calendar.integration).toMatchObject({ provider: 'GOOGLE_CALENDAR', status: 'CONNECTED', accountLogin: 'me@x.com' });
    expect(o.mail.integration).toMatchObject({ provider: 'GOOGLE_MAIL', accountLogin: 'box@x.com' });
    const raw = await h.t.admin.selectFrom('integrationTokens').select('tokenEnc').execute();
    expect(raw).toHaveLength(2);
    for (const r of raw) { expect(r.tokenEnc.startsWith('v1:')).toBe(true); expect(r.tokenEnc).not.toMatch(/at-cal|rt-cal|at-mail|rt-mail/); }
    expect(JSON.stringify(o)).not.toMatch(/at-cal|rt-cal|at-mail|rt-mail|tokenEnc/);
    const audit = await h.t.admin.selectFrom('auditLogs').select('action').where('action', '=', 'integration.connected').execute();
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('a role downgrade between start and finish is refused', async () => {
    const a = await pm.post(`${base()}/google/calendar/authorize`);
    expect(a.status).toBe(403); // PMs cannot manage integrations at all
  });
});

describe('calendar', () => {
  let calIntegration: string, sourceId: string;
  const seedEvent = async (ws: string, src: string, ext: string, startsInMin: number, lenMin = 30, extra: object = {}) =>
    (await h.t.admin.insertInto('calendarEvents').values({ organizationId: org, workspaceId: ws, sourceId: src, externalId: ext, title: `Event ${ext}`, startsAt: new Date(Date.now() + startsInMin * 60_000), endsAt: new Date(Date.now() + (startsInMin + lenMin) * 60_000), ...extra }).returning('id').executeTakeFirstOrThrow()).id;

  it('lists the account\'s calendars and connects one to ONE workspace', async () => {
    calIntegration = (await overview()).calendar.integration.id;
    expect((await dev.get(`${base()}/google/${calIntegration}/calendars`)).status).toBe(403);
    expect((await owner.get(`${base()}/google/${calIntegration}/calendars`)).body.data.map((c: { id: string }) => c.id)).toEqual(['me@x.com', 'team@x.com']);
    expect((await dev.post(`${base()}/google/${calIntegration}/calendar-sources`, { calendarId: 'team@x.com', workspaceId: ws1 })).status).toBe(403);
    expect((await owner.post(`${base()}/google/${calIntegration}/calendar-sources`, { calendarId: 'nope@x.com', workspaceId: ws1 })).status).toBe(404);
    expect((await owner.post(`${base()}/google/${calIntegration}/calendar-sources`, { calendarId: 'team@x.com', workspaceId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    const r = await owner.post(`${base()}/google/${calIntegration}/calendar-sources`, { calendarId: 'team@x.com', workspaceId: ws1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    sourceId = r.body.data.id;
    expect(r.body.data.name).toBe('Team');
    expect((await owner.post(`${base()}/google/${calIntegration}/calendar-sources`, { calendarId: 'team@x.com', workspaceId: ws2 })).status).toBe(409);
    expect(await h.t.admin.selectFrom('outboxEvents').select('id').where('type', '=', 'integration.google_sync_requested.v1').execute()).toHaveLength(1);
    // a mail integration id is not a calendar integration
    expect((await owner.get(`${base()}/google/${(await overview()).mail.integration.id}/calendars`)).status).toBe(404);
  });

  it('sync requests are permission-checked and rate limited', async () => {
    expect((await dev.post(`${base()}/google/calendar-sources/${sourceId}/sync`)).status).toBe(403);
    expect((await owner.post(`${base()}/google/calendar-sources/${sourceId}/sync`)).status).toBe(202);
    expect((await owner.post(`${base()}/google/calendar-sources/${sourceId}/sync`)).status).toBe(429);
  });

  it('events follow workspace visibility, honour the range, and flag overlaps (scheduling info)', async () => {
    const other = (await h.t.admin.insertInto('calendarSources').values({ organizationId: org, integrationId: calIntegration, workspaceId: ws2, calendarId: 'beta@x.com', name: 'Beta' }).returning('id').executeTakeFirstOrThrow()).id;
    const a = await seedEvent(ws1, sourceId, 'a', 60, 60);
    const b = await seedEvent(ws1, sourceId, 'b', 90, 60); // overlaps a
    const c = await seedEvent(ws1, sourceId, 'c', 300, 30); // alone
    await seedEvent(ws1, sourceId, 'far', 60 * 24 * 30, 30); // beyond the default 14-day window
    await seedEvent(ws1, sourceId, 'past', -600, 30);
    await seedEvent(ws1, sourceId, 'tent', 95, 30, { status: 'tentative' }); // tentative does not count as a conflict
    const e2 = await seedEvent(ws2, other, 'z', 70, 30);
    const mine = (await dev.get(`${base()}/calendar/events`)).body.data as Array<{ id: string; conflict: boolean; title: string }>;
    expect(mine.map((e) => e.title)).toEqual(['Event a', 'Event b', 'Event tent', 'Event c']);
    expect(Object.fromEntries(mine.map((e) => [e.title, e.conflict]))).toEqual({ 'Event a': true, 'Event b': true, 'Event tent': false, 'Event c': false });
    expect((await dev2.get(`${base()}/calendar/events`)).body.data.map((e: { id: string }) => e.id)).toEqual([e2]);
    expect((await owner.get(`${base()}/calendar/events`)).body.data).toHaveLength(5);
    const wide = await owner.get(`${base()}/calendar/events?from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 40 * 86400_000).toISOString()}`);
    expect(wide.body.data.map((e: { title: string }) => e.title)).toContain('Event far');
    expect((await owner.get(`${base()}/calendar/events?from=${new Date().toISOString()}&to=${new Date(Date.now() + 400 * 86400_000).toISOString()}`)).status).toBe(400);
    expect((await owner.get(`${base()}/calendar/events?workspaceId=${ws1}`)).body.data).toHaveLength(4);
  });

  it('meeting linking: same workspace only, one-to-one, sets "held at", audited, removable', async () => {
    const m1 = (await pm.post(`${base()}/meetings`, { workspaceId: ws1, title: 'Weekly sync', transcript: 'x' })).body.data.id;
    const m1b = (await pm.post(`${base()}/meetings`, { workspaceId: ws1, title: 'Other' })).body.data.id;
    const m2 = (await owner.post(`${base()}/meetings`, { workspaceId: ws2, title: 'Beta sync' })).body.data.id;
    const events = (await owner.get(`${base()}/calendar/events`)).body.data as Array<{ id: string; title: string; workspaceId: string }>;
    const ev1 = events.find((e) => e.title === 'Event c')!.id;
    const evBeta = events.find((e) => e.workspaceId === ws2)!.id;
    expect((await dev.post(`${base()}/meetings/${m1}/calendar-event`, { eventId: ev1 })).status).toBe(403);
    expect((await pm.post(`${base()}/meetings/${m1}/calendar-event`, { eventId: evBeta })).status).toBe(404); // event of another workspace
    expect((await pm.post(`${base()}/meetings/${m2}/calendar-event`, { eventId: ev1 })).status).toBe(404); // meeting not visible
    const ok = await pm.post(`${base()}/meetings/${m1}/calendar-event`, { eventId: ev1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await pm.post(`${base()}/meetings/${m1b}/calendar-event`, { eventId: ev1 })).status).toBe(409); // event already linked
    expect((await pm.post(`${base()}/meetings/${m1}/calendar-event`, { eventId: ev1 })).status).toBe(409);
    expect((await dev.get(`${base()}/meetings/${m1}/calendar-event`)).body.data).toMatchObject({ id: ev1, title: 'Event c' });
    expect((await dev.get(`${base()}/calendar/events`)).body.data.find((e: { id: string }) => e.id === ev1).meetingId).toBe(m1);
    const mt = await h.t.admin.selectFrom('meetings').select('heldAt').where('id', '=', m1).executeTakeFirstOrThrow();
    expect(mt.heldAt).not.toBeNull();
    expect((await pm.delete(`${base()}/meetings/${m1}/calendar-event`)).status).toBe(200);
    expect((await pm.delete(`${base()}/meetings/${m1}/calendar-event`)).status).toBe(404);
    expect((await dev.get(`${base()}/meetings/${m1}/calendar-event`)).body.data).toBeNull();
    const acts = (await h.t.admin.selectFrom('auditLogs').select('action').where('action', 'like', 'meeting.calendar_%').execute()).map((x) => x.action).sort();
    expect(acts).toEqual(['meeting.calendar_linked', 'meeting.calendar_unlinked']);
  });

  it('disconnecting a calendar stops syncing but keeps what was synced', async () => {
    expect((await dev.delete(`${base()}/google/calendar-sources/${sourceId}`)).status).toBe(403);
    expect((await owner.delete(`${base()}/google/calendar-sources/${sourceId}`)).status).toBe(200);
    expect((await owner.post(`${base()}/google/calendar-sources/${sourceId}/sync`)).status).toBe(409);
    expect((await overview()).calendar.sources.map((s: { id: string }) => s.id)).not.toContain(sourceId);
    expect((await owner.get(`${base()}/calendar/events`)).body.data.length).toBeGreaterThan(0);
  });
});

describe('mailbox and email', () => {
  let mailIntegration: string, sourceId: string, msgId: string, actionId: string, decisionId: string, msg2: string;
  const seed = async () => {
    msgId = (await h.t.admin.insertInto('emailMessages').values({ organizationId: org, workspaceId: ws1, sourceId, externalId: 'g1', subject: 'ZEU launch', fromAddress: 'ann@x.com', receivedAt: new Date(), excerpt: 'We decided X. Dana to write the notes.', status: 'EXTRACTED', summary: 'Launch', projectId: proj1b, linkSource: 'AUTO' }).returning('id').executeTakeFirstOrThrow()).id;
    msg2 = (await h.t.admin.insertInto('emailMessages').values({ organizationId: org, workspaceId: ws1, sourceId, externalId: 'g2', subject: 'unlinked', receivedAt: new Date(), excerpt: 'hello', status: 'EXTRACTED' }).returning('id').executeTakeFirstOrThrow()).id;
    const it = (kind: 'DECISION' | 'ACTION_ITEM', text: string) => h.t.admin.insertInto('emailItems').values({ organizationId: org, workspaceId: ws1, messageId: msgId, kind, text, assigneeHint: kind === 'ACTION_ITEM' ? 'Dana' : null }).returning('id').executeTakeFirstOrThrow().then((r) => r.id);
    actionId = await it('ACTION_ITEM', 'Write the launch notes');
    decisionId = await it('DECISION', 'Ship on Friday');
  };

  it('connects ONE mailbox label to a workspace (and optionally a project)', async () => {
    mailIntegration = (await overview()).mail.integration.id;
    expect((await dev.post(`${base()}/google/${mailIntegration}/mailbox`, { workspaceId: ws1 })).status).toBe(403);
    expect((await owner.post(`${base()}/google/${mailIntegration}/mailbox`, { workspaceId: ws1, projectId: proj2 })).status).toBe(400);
    expect((await owner.post(`${base()}/google/${mailIntegration}/mailbox`, { workspaceId: ws1, label: 'x" OR in:anywhere' })).status).toBe(400);
    const r = await owner.post(`${base()}/google/${mailIntegration}/mailbox`, { workspaceId: ws1, projectId: proj1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.label).toBe('TeamOS');
    sourceId = r.body.data.id;
    expect((await owner.post(`${base()}/google/${mailIntegration}/mailbox`, { workspaceId: ws1 })).status).toBe(409);
    expect((await owner.get(`${base()}/google/${(await overview()).calendar.integration.id}/mailbox`)).status).toBe(404);
    expect((await owner.post(`${base()}/google/mailboxes/${sourceId}/sync`)).status).toBe(202);
    expect((await owner.post(`${base()}/google/mailboxes/${sourceId}/sync`)).status).toBe(429);
    await seed();
  });

  it('email visibility follows the workspace; filters work; nothing sensitive beyond the stored excerpt is exposed', async () => {
    expect((await dev.get(`${base()}/emails`)).body.data).toHaveLength(2);
    expect((await dev2.get(`${base()}/emails`)).body.data).toEqual([]);
    expect((await dev2.get(`${base()}/emails/${msgId}`)).status).toBe(404);
    expect((await h.client().get(`${base()}/emails`)).status).toBe(401);
    expect((await dev.get(`${base()}/emails?linked=false`)).body.data.map((m: { id: string }) => m.id)).toEqual([msg2]);
    const list = (await dev.get(`${base()}/emails?linked=true`)).body.data[0];
    expect(list).toMatchObject({ id: msgId, projectKey: 'ZEU', linkSource: 'AUTO', pendingItems: 2 });
    const d = (await dev.get(`${base()}/emails/${msgId}`)).body.data;
    expect(d.items).toHaveLength(2);
    expect(d.excerpt).toContain('Dana');
  });

  it('linking an email to a project: same workspace only, manual, audited, removable', async () => {
    expect((await dev2.put(`${base()}/emails/${msg2}/project`, { projectId: proj2 })).status).toBe(404);
    expect((await dev.put(`${base()}/emails/${msg2}/project`, { projectId: proj2 })).status).toBe(400);
    expect((await dev.put(`${base()}/emails/${msg2}/project`, { projectId: proj1 })).status).toBe(200);
    expect((await dev.get(`${base()}/emails/${msg2}`)).body.data).toMatchObject({ projectKey: 'APO', linkSource: 'MANUAL' });
    expect((await dev.put(`${base()}/emails/${msg2}/project`, { projectId: null })).status).toBe(200);
    expect((await dev.get(`${base()}/emails/${msg2}`)).body.data).toMatchObject({ projectId: null, linkSource: null });
    expect((await h.t.admin.selectFrom('auditLogs').select('action').where('action', 'in', ['email.linked', 'email.unlinked']).execute()).map((a) => a.action).sort()).toEqual(['email.linked', 'email.unlinked']);
  });

  it('only approvers decide: approving an action item creates the task atomically; decisions create nothing; no double approval', async () => {
    expect((await dev.post(`${base()}/emails/${msgId}/items/${actionId}/approve`, {})).status).toBe(403);
    expect((await dev.post(`${base()}/emails/${msgId}/items/${actionId}/reject`)).status).toBe(403);
    expect((await dev.patch(`${base()}/emails/${msgId}/items/${actionId}`, { text: 'x' })).status).toBe(403);
    expect((await pm.patch(`${base()}/emails/${msgId}/items/${actionId}`, { text: 'Write the launch notes (final)', priority: 'HIGH' })).status).toBe(200);
    expect((await pm.post(`${base()}/emails/${msgId}/items/${actionId}/approve`, { projectId: proj2 })).status).toBe(400); // other workspace
    expect(await h.t.admin.selectFrom('tasks').select('id').execute()).toHaveLength(0); // nothing happened before a valid approval
    const ok = await pm.post(`${base()}/emails/${msgId}/items/${actionId}/approve`, {}); // defaults to the email's project (ZEU)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.taskId).toBeTruthy();
    const task = await h.t.admin.selectFrom('tasks as t').innerJoin('projects as p', 'p.id', 't.projectId').select(['t.title', 't.priority', 'p.key']).where('t.id', '=', ok.body.data.taskId).executeTakeFirstOrThrow();
    expect(task).toMatchObject({ title: 'Write the launch notes (final)', priority: 'HIGH', key: 'ZEU' });
    expect((await pm.post(`${base()}/emails/${msgId}/items/${actionId}/approve`, {})).status).toBe(409);
    expect((await pm.post(`${base()}/emails/${msgId}/items/${actionId}/reject`)).status).toBe(409);
    expect((await pm.patch(`${base()}/emails/${msgId}/items/${actionId}`, { text: 'again' })).status).toBe(409);
    const dec = await pm.post(`${base()}/emails/${msgId}/items/${decisionId}/approve`, {});
    expect(dec.status).toBe(200);
    expect(dec.body.data.taskId).toBeNull();
    expect(await h.t.admin.selectFrom('tasks').select('id').execute()).toHaveLength(1);
    const audit = await h.t.admin.selectFrom('auditLogs').select('action').where('action', 'like', 'email.item_%').execute();
    expect(audit.map((a) => a.action)).toEqual(['email.item_approved', 'email.item_approved']);
  });

  it('three concurrent approvals create exactly one task; an action item with no project needs one', async () => {
    const mk = async (text: string, msg = msgId) => (await h.t.admin.insertInto('emailItems').values({ organizationId: org, workspaceId: ws1, messageId: msg, kind: 'ACTION_ITEM', text }).returning('id').executeTakeFirstOrThrow()).id;
    const it1 = await mk('Race');
    const before = (await h.t.admin.selectFrom('tasks').select('id').execute()).length;
    const rs = await Promise.all([1, 2, 3].map(() => pm.post(`${base()}/emails/${msgId}/items/${it1}/approve`, {})));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await h.t.admin.selectFrom('tasks').select('id').execute()).length).toBe(before + 1);
    const it2 = await mk('No project anywhere', msg2);
    expect((await pm.post(`${base()}/emails/${msg2}/items/${it2}/approve`, {})).status).toBe(400);
    expect((await pm.post(`${base()}/emails/${msg2}/items/${it2}/approve`, { projectId: proj1 })).status).toBe(200);
    const it3 = await mk('Reject me');
    expect((await pm.post(`${base()}/emails/${msgId}/items/${it3}/reject`)).status).toBe(200);
    expect((await h.t.admin.selectFrom('emailItems').select('status').where('id', '=', it3).executeTakeFirstOrThrow()).status).toBe('REJECTED');
  });

  it('disconnecting the mailbox stops it; the stored mail remains readable by the workspace', async () => {
    expect((await dev.delete(`${base()}/google/mailboxes/${sourceId}`)).status).toBe(403);
    expect((await owner.delete(`${base()}/google/mailboxes/${sourceId}`)).status).toBe(200);
    expect((await owner.post(`${base()}/google/mailboxes/${sourceId}/sync`)).status).toBe(409);
    expect((await overview()).mail.source).toBeNull();
    expect((await dev.get(`${base()}/emails`)).body.data).toHaveLength(2);
    // reconnecting the same integration reuses the source row
    const again = await owner.post(`${base()}/google/${mailIntegration}/mailbox`, { workspaceId: ws1, label: 'Work/Decisions' });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.id).toBe(sourceId);
  });
});

describe('disconnecting Google', () => {
  it('flips everything off first, revokes the grant at Google, deletes the token, and is audited', async () => {
    const o = await overview();
    const id = o.mail.integration.id;
    expect((await dev.delete(`${base()}/google/${id}`)).status).toBe(403);
    expect((await owner.delete(`${base()}/google/${id}`)).status).toBe(200);
    expect(g.st.revoked).toContain('rt-mail'); // the refresh token is what gets revoked
    expect(await h.t.admin.selectFrom('integrationTokens').select('integrationId').where('integrationId', '=', id).execute()).toEqual([]);
    expect((await h.t.admin.selectFrom('emailSources').select('active').execute()).every((s) => !s.active)).toBe(true);
    expect((await overview()).mail.integration).toBeNull();
    expect((await owner.delete(`${base()}/google/${id}`)).status).toBe(409);
    expect((await owner.post(`${base()}/google/${id}/mailbox`, { workspaceId: ws1 })).status).toBe(409);
    const acts = (await h.t.admin.selectFrom('auditLogs').select('action').execute()).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(['integration.disconnected', 'integration.calendar_connected', 'integration.calendar_disconnected', 'integration.mailbox_connected', 'integration.mailbox_disconnected']));
    // GitHub-style ids are not accepted here
    expect((await owner.delete(`${base()}/google/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('a revoked refresh token is reported as a conflict (not a 500) and marks the integration ERROR', async () => {
    await connect(owner, 'calendar', 'cal'); // calendar integration was connected earlier: this reconnect refreshes it
    const id = (await overview()).calendar.integration.id;
    // make the stored access token look expired, then have Google reject the refresh
    const { encryptSecret } = await import('@teamos/integrations');
    await h.t.admin.updateTable('integrationTokens').set({ tokenEnc: encryptSecret(JSON.stringify({ accessToken: 'old', refreshToken: 'rt', expiresAt: 0 }), h.config.integrationKey!, `token:${id}`) }).where('integrationId', '=', id).execute();
    g.st.refreshFails = true;
    expect((await owner.get(`${base()}/google/${id}/calendars`)).status).toBe(409);
    expect((await overview()).calendar.integration.status).toBe('ERROR');
    g.st.refreshFails = false;
  });
});

describe('not configured', () => {
  it('reports configured=false, refuses OAuth, and the callback cannot be abused', async () => {
    const h2 = await createHarness();
    try {
      const o = await h2.signup('solo@g.com');
      const orgId = (await o.post('/organizations', { name: 'Solo' })).body.data.id;
      const ov = await o.get(`/organizations/${orgId}/google`);
      expect(ov.body.data).toMatchObject({ configured: false, calendar: { integration: null, sources: [] }, mail: { integration: null, source: null } });
      expect((await o.post(`/organizations/${orgId}/google/calendar/authorize`)).status).toBe(503);
      expect((await o.get('/integrations/google/callback?code=x&state=aaaaaaaaaaaaaaaaaaaa')).status).toBe(503);
    } finally {
      await h2.close();
    }
  }, 60_000);
});
