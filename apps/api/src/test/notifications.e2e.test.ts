import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rtOrgChannel, rtUserChannel } from '@teamos/event-contracts';
import { createHarness, type Client, type Harness } from './harness';

let h: Harness;
let owner: Client;
let dev: Client; // DEVELOPER in ws1 only
let outsider: Client;
let org: string;
let ws1: string;
let ws2: string;
let url: string;
const base = () => `/organizations/${org}`;

async function addMember(email: string, role: string, workspaceIds: string[]): Promise<Client> {
  const c = await h.signup(email);
  expect((await owner.post(`${base()}/invitations`, { email, role, workspaceIds })).status).toBe(201);
  const token = await h.tokenFor('member.invited.v1', email);
  expect((await c.post('/invitations/accept', { token })).status).toBe(200);
  return c;
}

const seed = (userId: string, title: string, dedupeKey: string, extra: object = {}) =>
  h.t.admin
    .insertInto('notifications')
    .values({ organizationId: org, userId, category: 'TASK_ASSIGNED', title, dedupeKey, ...extra })
    .returning('id')
    .executeTakeFirstOrThrow();

beforeAll(async () => {
  h = await createHarness();
  owner = await h.signup('owner@n.com', 'Owner');
  outsider = await h.signup('out@n.com', 'Outsider');
  org = (await owner.post('/organizations', { name: 'Notif Org' })).body.data.id;
  await outsider.post('/organizations', { name: 'Other Org' });
  ws1 = (await owner.post(`${base()}/workspaces`, { name: 'Alpha' })).body.data.id;
  ws2 = (await owner.post(`${base()}/workspaces`, { name: 'Beta' })).body.data.id;
  dev = await addMember('dev@n.com', 'DEVELOPER', [ws1]);
  url = await h.listen();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('notifications API', () => {
  it('lists only my own, counts unread, marks read, and hides others', async () => {
    const a = await seed(dev.userId, 'one', 'k1');
    await seed(dev.userId, 'two', 'k2');
    await seed(owner.userId, 'owners', 'k3');

    const list = await dev.get(`${base()}/notifications`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((n: { title: string }) => n.title).sort()).toEqual(['one', 'two']);
    expect(list.body.meta.total).toBe(2);
    expect((await dev.get(`${base()}/notifications/unread-count`)).body.data.count).toBe(2);

    // someone else's notification is a 404, not a 403 (no existence leak)
    const ownerRow = await h.t.admin.selectFrom('notifications').select('id').where('userId', '=', owner.userId).executeTakeFirstOrThrow();
    expect((await dev.post(`${base()}/notifications/${ownerRow.id}/read`)).status).toBe(404);

    const read = await dev.post(`${base()}/notifications/${a.id}/read`);
    expect(read.status).toBe(200);
    expect(read.body.data.readAt).toBeTruthy();
    expect((await dev.get(`${base()}/notifications/unread-count`)).body.data.count).toBe(1);
    expect((await dev.get(`${base()}/notifications?unread=true`)).body.data).toHaveLength(1);

    const all = await dev.post(`${base()}/notifications/read-all`);
    expect(all.body.data.updated).toBe(1);
    expect((await dev.get(`${base()}/notifications/unread-count`)).body.data.count).toBe(0);
    // owner's untouched
    expect((await owner.get(`${base()}/notifications/unread-count`)).body.data.count).toBe(1);
  });

  it('rejects bad ids and non-members', async () => {
    expect((await dev.post(`${base()}/notifications/not-a-uuid/read`)).status).toBe(400);
    expect((await outsider.get(`${base()}/notifications`)).status).toBe(404);
    expect((await h.client().get(`${base()}/notifications`)).status).toBe(401);
  });

  it('reads and updates preferences with defaults, and validates', async () => {
    const def = await dev.get('/me/notification-preferences');
    expect(def.status).toBe(200);
    const assigned = def.body.data.find((p: { category: string }) => p.category === 'TASK_ASSIGNED');
    expect(assigned).toMatchObject({ inApp: true, email: true });

    const put = await dev.put('/me/notification-preferences', { preferences: [{ category: 'TASK_ASSIGNED', inApp: true, email: false }] });
    expect(put.status).toBe(200);
    expect(put.body.data.find((p: { category: string }) => p.category === 'TASK_ASSIGNED').email).toBe(false);
    // other users unaffected
    const ownerPrefs = await owner.get('/me/notification-preferences');
    expect(ownerPrefs.body.data.find((p: { category: string }) => p.category === 'TASK_ASSIGNED').email).toBe(true);

    expect((await dev.put('/me/notification-preferences', { preferences: [{ category: 'NOPE', inApp: true, email: true }] })).status).toBe(400);
  });
});

// ---------- SSE ----------
interface Sse {
  events: { event: string; data: unknown }[];
  status: number;
  closed: Promise<void>;
  waitFor(pred: (e: { event: string; data: unknown }) => boolean, ms?: number): Promise<void>;
  stop(): void;
}

async function openStream(c: Client, orgId = org): Promise<Sse> {
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/v1/organizations/${orgId}/stream`, { headers: { cookie: c.cookie }, signal: ctrl.signal });
  const events: Sse['events'] = [];
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
          }
        }
      } catch {
        /* aborted */
      }
      resolveClosed();
    })();
  } else {
    await res.body?.cancel().catch(() => undefined);
    resolveClosed();
  }
  const waitFor: Sse['waitFor'] = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (events.some(pred)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout; saw ${JSON.stringify(events)}`);
  };
  return { events, status: res.status, closed, waitFor, stop: () => ctrl.abort() };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('live stream (SSE)', () => {
  it('requires auth and org membership', async () => {
    const anon = await fetch(`${url}/api/v1/organizations/${org}/stream`);
    expect(anon.status).toBe(401);
    await anon.body?.cancel();
    const out = await openStream(outsider);
    expect(out.status).toBe(404);
  });

  it('delivers visible hints, drops invisible ones and ignores forged notification messages', async () => {
    const s = await openStream(dev);
    expect(s.status).toBe(200);
    await s.waitFor((e) => e.event === 'ready');

    h.bus.publish(rtOrgChannel(org), { k: 'hint', hint: { type: 'task.updated', workspaceId: ws1, taskId: 'T1' } });
    h.bus.publish(rtOrgChannel(org), { k: 'hint', hint: { type: 'task.updated', workspaceId: ws2, taskId: 'HIDDEN' } });
    h.bus.publish(rtOrgChannel(org), { k: 'hint', hint: { type: 'member.changed' } }); // org-wide
    // a notification message is only valid on the user's own channel
    h.bus.publish(rtOrgChannel(org), { k: 'notification', notification: { id: 'x', category: 'TASK_ASSIGNED', title: 'forged', link: '/' } });
    h.bus.publish(rtUserChannel(dev.userId), { k: 'notification', notification: { id: 'n1', category: 'TASK_ASSIGNED', title: 'real', link: '/' } });

    await s.waitFor((e) => e.event === 'notification');
    await settle();
    const hints = s.events.filter((e) => e.event === 'hint').map((e) => (e.data as { taskId?: string; type: string }));
    expect(hints.map((x) => x.taskId ?? x.type)).toEqual(['T1', 'member.changed']);
    expect(s.events.filter((e) => e.event === 'notification').map((e) => (e.data as { title: string }).title)).toEqual(['real']);
    s.stop();
  });

  it('closes the stream when the session ends', async () => {
    const c = await h.signup('temp@n.com');
    expect((await owner.post(`${base()}/invitations`, { email: 'temp@n.com', role: 'DEVELOPER', workspaceIds: [ws1] })).status).toBe(201);
    await c.post('/invitations/accept', { token: await h.tokenFor('member.invited.v1', 'temp@n.com') });
    const s = await openStream(c);
    await s.waitFor((e) => e.event === 'ready');
    expect((await c.post('/auth/logout')).status).toBeLessThan(300);
    await s.waitFor((e) => e.event === 'close');
    expect((s.events.find((e) => e.event === 'close')!.data as { reason: string }).reason).toBe('session_ended');
    await s.closed;
  });

  it('closes the stream when membership is revoked', async () => {
    const c = await addMember('gone@n.com', 'DEVELOPER', [ws1]);
    const s = await openStream(c);
    await s.waitFor((e) => e.event === 'ready');
    expect((await owner.delete(`${base()}/members/${c.userId}`)).status).toBeLessThan(300);
    await s.waitFor((e) => e.event === 'close');
    expect((s.events.find((e) => e.event === 'close')!.data as { reason: string }).reason).toBe('access_revoked');
    await s.closed;
  });

  it('caps simultaneous streams per user and frees the slot on disconnect', async () => {
    const c = await addMember('cap@n.com', 'DEVELOPER', [ws1]);
    const open = [await openStream(c), await openStream(c), await openStream(c)];
    expect(open.map((o) => o.status)).toEqual([200, 200, 200]);
    const fourth = await openStream(c);
    expect(fourth.status).toBe(429);
    open[0]!.stop();
    await open[0]!.closed;
    await settle();
    const again = await openStream(c);
    expect(again.status).toBe(200);
    again.stop();
    open.slice(1).forEach((o) => o.stop());
    expect(h.bus.subscriberCount).toBeGreaterThanOrEqual(0);
  });
});
