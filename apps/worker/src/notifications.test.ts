import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { createTestDatabase, type TestDatabase } from '@teamos/database';
import type { Mailer, MailMessage } from './mailer';
import { runCleanup, runDueReminders, runExpireAgentActions } from './maintenance';
import { createNotificationProcessor } from './notification.processor';
import { MemoryPublisher } from './realtime';
import { relayOnce } from './relay';
import type { JobData } from './queues';

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  failNext = 0;
  async send(m: MailMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('smtp down');
    }
    this.sent.push(m);
  }
}

let t: TestDatabase;
let mailer: FakeMailer;
let publisher: MemoryPublisher;
let process: ReturnType<typeof createNotificationProcessor>;
const f = {} as Record<string, string>;
let evt = 0;
const uuidN = () => `00000000-0000-4000-8000-${String(++evt).padStart(12, '0')}`;
const job = (type: string, payload: object, eventId = uuidN()) => ({ data: { eventId, type, payload } }) as unknown as Job<JobData>;

const notes = (userId: string) =>
  t.admin.selectFrom('notifications').select(['title', 'category', 'body', 'link']).where('userId', '=', userId).orderBy('createdAt').execute();

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const mkUser = async (n: string) =>
    (await a.insertInto('users').values({ email: `${n.toLowerCase()}@x.com`, name: n, passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.owner = await mkUser('Olivia');
  f.rep = await mkUser('Rita');     // reporter, ws member
  f.dev = await mkUser('Dan');      // assignee, ws member
  f.other = await mkUser('Oscar');  // commenter, ws member
  f.outsider = await mkUser('Ola'); // org member but NOT in the workspace
  f.org = (await a.insertInto('organizations').values({ name: 'o', slug: 'o', createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('organizationMembers').values([
    { organizationId: f.org, userId: f.owner, role: 'OWNER' },
    { organizationId: f.org, userId: f.rep, role: 'DEVELOPER' },
    { organizationId: f.org, userId: f.dev, role: 'DEVELOPER' },
    { organizationId: f.org, userId: f.other, role: 'DEVELOPER' },
    { organizationId: f.org, userId: f.outsider, role: 'DEVELOPER' },
  ]).execute();
  f.ws = (await a.insertInto('workspaces').values({ organizationId: f.org, name: 'w', slug: 'w' }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('workspaceMembers').values(
    [f.rep, f.dev, f.other].map((u) => ({ organizationId: f.org, workspaceId: f.ws, userId: u, role: 'DEVELOPER' as const })),
  ).execute();
  f.proj = (await a.insertInto('projects').values({ organizationId: f.org, workspaceId: f.ws, key: 'AB', name: 'p', createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.task = (await a.insertInto('tasks').values({
    organizationId: f.org, workspaceId: f.ws, projectId: f.proj, number: 1, title: 'Fix login', reporterId: f.rep, assigneeId: f.dev,
  }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('comments').values({ organizationId: f.org, workspaceId: f.ws, taskId: f.task, authorId: f.other, body: 'hm' }).execute();
}, 60_000);

afterAll(async () => t?.destroy());

const fresh = () => {
  mailer = new FakeMailer();
  publisher = new MemoryPublisher();
  process = createNotificationProcessor({ db: t.db, mailer, publisher, appUrl: 'http://app.test' });
};
const base = () => ({ organizationId: f.org, workspaceId: f.ws, projectId: f.proj, taskId: f.task, title: 'Fix login' });

describe('notification processor', () => {
  it('notifies the assignee in-app + by email, pushes a live message, and is idempotent', async () => {
    fresh();
    const j = job('task.assigned.v1', { ...base(), assigneeId: f.dev, previousAssigneeId: null, assignedByUserId: f.rep });
    expect(await process(j)).toEqual({ delivered: 1, skipped: 0 });
    expect(await process(j)).toEqual({ delivered: 0, skipped: 1 }); // same event again
    const n = await notes(f.dev);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ category: 'TASK_ASSIGNED', title: 'Rita assigned you AB-1', body: 'Fix login' });
    expect(n[0]!.link).toBe(`/o/${f.org}/projects/${f.proj}?task=${f.task}`);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('dan@x.com');
    expect(mailer.sent[0]!.html).toContain(`http://app.test/o/${f.org}/projects/${f.proj}?task=${f.task}`);
    expect(publisher.sent).toHaveLength(1);
    expect(publisher.sent[0]!.channel).toBe(`rt:user:${f.dev}`);
  });

  it('does not notify on self-assignment', async () => {
    fresh();
    const before = (await notes(f.dev)).length;
    await process(job('task.assigned.v1', { ...base(), assigneeId: f.dev, previousAssigneeId: null, assignedByUserId: f.dev }));
    expect((await notes(f.dev)).length).toBe(before);
  });

  it('comments go to reporter, assignee and earlier commenters — not the author', async () => {
    fresh();
    const c = await t.admin.insertInto('comments').values({ organizationId: f.org, workspaceId: f.ws, taskId: f.task, authorId: f.dev, body: 'on it' }).returning('id').executeTakeFirstOrThrow();
    const r = await process(job('task.commented.v1', { ...base(), commentId: c.id, authorId: f.dev }));
    expect(r.delivered).toBe(2); // Rita (reporter) + Oscar (earlier commenter)
    expect((await notes(f.rep)).some((n) => n.title === 'Dan commented on AB-1')).toBe(true);
    expect((await notes(f.other)).some((n) => n.title === 'Dan commented on AB-1')).toBe(true);
    expect((await notes(f.dev)).some((n) => n.category === 'TASK_COMMENT')).toBe(false);
    expect(mailer.sent).toHaveLength(0); // email is off by default for comments
  });

  it('status changes notify reporter and assignee except the person who made the change', async () => {
    fresh();
    await process(job('task.status_changed.v1', { ...base(), previousStatus: 'TODO', newStatus: 'IN_PROGRESS', changedByUserId: f.dev }));
    expect((await notes(f.rep)).some((n) => n.title === 'AB-1 moved to in progress')).toBe(true);
    expect((await notes(f.dev)).some((n) => n.title.includes('moved to'))).toBe(false);
  });

  it('respects preferences (in-app off, email on) and never leaks to people without access', async () => {
    fresh();
    await t.admin.insertInto('notificationPreferences').values({ userId: f.rep, category: 'TASK_STATUS', inApp: false, email: true }).execute();
    const before = (await notes(f.rep)).length;
    await process(job('task.status_changed.v1', { ...base(), previousStatus: 'IN_PROGRESS', newStatus: 'DONE', changedByUserId: f.dev }));
    expect((await notes(f.rep)).length).toBe(before); // no in-app row
    expect(mailer.sent.map((m) => m.to)).toEqual(['rita@x.com']); // but the email went out

    // assignee loses workspace access -> nothing is delivered to them any more
    fresh();
    await t.admin.updateTable('tasks').set({ reporterId: f.outsider }).where('id', '=', f.task).execute();
    await t.admin.updateTable('workspaceMembers').set({ deletedAt: new Date() }).where('userId', '=', f.dev).execute();
    const r = await process(job('task.status_changed.v1', { ...base(), previousStatus: 'DONE', newStatus: 'TODO', changedByUserId: f.rep }));
    expect(r.delivered).toBe(0);
    expect(await notes(f.outsider)).toHaveLength(0);
    expect((await notes(f.dev)).some((n) => n.title.includes('moved to todo'))).toBe(false);
    // restore
    await t.admin.updateTable('workspaceMembers').set({ deletedAt: null }).where('userId', '=', f.dev).execute();
    await t.admin.updateTable('tasks').set({ reporterId: f.rep }).where('id', '=', f.task).execute();
  });

  it('retries after an email failure without duplicating the notification or the email', async () => {
    fresh();
    const j = job('task.assigned.v1', { ...base(), assigneeId: f.other, previousAssigneeId: null, assignedByUserId: f.rep });
    const n0 = (await notes(f.other)).length;
    mailer.failNext = 1;
    await expect(process(j)).rejects.toThrow(/delivery failed/);
    expect(mailer.sent).toHaveLength(0);
    expect((await notes(f.other)).length).toBe(n0 + 1); // the in-app row from the first attempt exists
    await process(j); // BullMQ retry
    expect(mailer.sent).toHaveLength(1);
    expect((await notes(f.other)).length).toBe(n0 + 1); // still just one
    await process(j);
    expect(mailer.sent).toHaveLength(1); // and still one email
  });

  it('ignores events for deleted tasks and rejects unknown event types', async () => {
    fresh();
    const gone = (await t.admin.insertInto('tasks').values({ organizationId: f.org, workspaceId: f.ws, projectId: f.proj, number: 9, title: 'x', reporterId: f.rep, assigneeId: f.dev, deletedAt: new Date() }).returning('id').executeTakeFirstOrThrow()).id;
    expect(await process(job('task.assigned.v1', { ...base(), taskId: gone, assigneeId: f.dev, previousAssigneeId: null, assignedByUserId: f.rep }))).toEqual({ delivered: 0, skipped: 0 });
    await expect(process(job('member.joined.v1', {}))).rejects.toThrow(/cannot handle/);
  });
});

describe('scheduled jobs', () => {
  it('sends due-soon and overdue reminders once per task/due date', async () => {
    fresh();
    const deps = { db: t.db, mailer, publisher, appUrl: 'http://app.test' };
    const mk = (n: number, due: string, extra: object = {}) =>
      t.admin.insertInto('tasks').values({ organizationId: f.org, workspaceId: f.ws, projectId: f.proj, number: n, title: `T${n}`, reporterId: f.rep, assigneeId: f.other, dueDate: due, ...extra }).returning('id').executeTakeFirstOrThrow();
    await mk(20, '2026-07-11'); // tomorrow
    await mk(21, '2026-07-10'); // today
    await mk(22, '2026-07-05'); // overdue
    await mk(23, '2026-07-11', { status: 'DONE' });
    await mk(24, '2026-08-30'); // far away
    const now = new Date('2026-07-10T09:00:00Z');
    const first = await runDueReminders(deps, now);
    expect(first).toEqual({ scanned: 3, delivered: 3 });
    const titles = (await notes(f.other)).map((n) => n.title).filter((x) => /AB-2[0-4]/.test(x)).sort();
    expect(titles).toEqual(['AB-20 is due tomorrow', 'AB-21 is due today', 'AB-22 is overdue']);
    expect(mailer.sent).toHaveLength(3); // TASK_DUE emails default on
    const again = await runDueReminders(deps, now);
    expect(again.delivered).toBe(0);
    expect(mailer.sent).toHaveLength(3);
    // Next day: AB-20 is now "due today" (same due:<task>:<date> key -> no repeat) and AB-22 was already told;
    // but AB-21 has become overdue, which is a genuinely new reminder.
    const next = await runDueReminders(deps, new Date('2026-07-11T09:00:00Z'));
    expect(next.delivered).toBe(1);
    expect((await notes(f.other)).map((n) => n.title)).toContain('AB-21 is overdue');
    expect((await runDueReminders(deps, new Date('2026-07-11T09:00:00Z'))).delivered).toBe(0);
  });

  it('expires only overdue pending agent proposals, and is idempotent', async () => {
    const mkTask = (n: number) => t.admin.insertInto('tasks').values({ organizationId: f.org, workspaceId: f.ws, projectId: f.proj, number: n, title: `X${n}`, reporterId: f.rep }).returning('id').executeTakeFirstOrThrow();
    const mk = async (n: number, expiresAt: Date) => {
      const task = await mkTask(n);
      return (await t.admin.insertInto('agentActions').values({
        organizationId: f.org, workspaceId: f.ws, projectId: f.proj, agent: 'TASK_MANAGEMENT', actionType: 'TASK_ASSIGN', targetTaskId: task.id, targetVersion: 'v',
        payload: JSON.stringify({ assigneeId: f.dev }), payloadHash: 'c'.repeat(64), beforeState: '{}', afterState: '{}', rationale: 'r', proposedBy: f.rep, expiresAt,
      }).returning('id').executeTakeFirstOrThrow()).id;
    };
    const old = await mk(40, new Date('2026-07-01T00:00:00Z'));
    const live = await mk(41, new Date('2026-08-01T00:00:00Z'));
    const now = new Date('2026-07-10T09:00:00Z');
    expect(await runExpireAgentActions({ db: t.db }, now)).toEqual({ expired: 1 });
    expect(await runExpireAgentActions({ db: t.db }, now)).toEqual({ expired: 0 });
    const st = async (id: string) => (await t.admin.selectFrom('agentActions').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
    expect(await st(old)).toBe('EXPIRED');
    expect(await st(live)).toBe('PENDING');
  });

  it('cleanup reports what it removed', async () => {
    const r = await runCleanup({ db: t.db }, new Date());
    expect(Object.keys(r).sort()).toEqual(['email_tokens', 'notifications', 'oauth_states', 'outbox_events', 'processed_events', 'sessions', 'webhook_events']);
  });
});

describe('relay publishes live-update hints', () => {
  it('publishes ids only, skips secret-bearing events, and a publisher failure does not fail the event', async () => {
    fresh();
    const emit = (type: string, payload: object) =>
      t.admin.insertInto('outboxEvents').values({ type, organizationId: f.org, workspaceId: f.ws, payload: JSON.stringify(payload), lastError: null }).returning('id').executeTakeFirstOrThrow();
    await t.admin.deleteFrom('outboxEvents').execute().catch(() => undefined);
    await emit('task.updated.v1', { ...base(), fields: ['title'], changedByUserId: f.rep });
    await emit('member.invited.v1', { organizationId: f.org, invitationId: f.org, email: 'a@b.com', role: 'DEVELOPER', token: 'SECRET-TOKEN', invitedByUserId: f.rep, organizationName: 'o' });
    const res = await relayOnce(t.db, { email: { add: async () => undefined } as never }, 50, () => undefined, publisher);
    expect(res).toMatchObject({ claimed: 2, published: 2, failed: 0 });
    expect(publisher.sent).toHaveLength(1);
    expect(publisher.sent[0]!.channel).toBe(`rt:org:${f.org}`);
    expect(publisher.sent[0]!.message).toEqual({ k: 'hint', hint: { type: 'task.updated', workspaceId: f.ws, projectId: f.proj, taskId: f.task } });
    expect(JSON.stringify(publisher.sent)).not.toContain('SECRET');

    const failing = { publish: async () => { throw new Error('redis down'); } };
    await emit('task.updated.v1', { ...base(), fields: ['title'], changedByUserId: f.rep });
    const r2 = await relayOnce(t.db, {}, 50, () => undefined, failing);
    expect(r2).toMatchObject({ claimed: 1, published: 1, failed: 0 });
  });
});
