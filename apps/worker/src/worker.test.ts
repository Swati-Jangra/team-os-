import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, sql, withContext, type TestDatabase } from '@teamos/database';
import { createEmailProcessor } from './email.processor';
import type { Mailer, MailMessage } from './mailer';
import { DEFAULT_JOB_OPTIONS, type JobData } from './queues';
import { relayOnce } from './relay';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let t: TestDatabase;
let connection: IORedis;
let queue: Queue<JobData>;
const prefix = `test-${randomUUID().slice(0, 8)}`;
const uid = '11111111-1111-4111-8111-111111111111';

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  failTimes = 0;
  async send(m: MailMessage) {
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error('smtp down');
    }
    this.sent.push(m);
  }
}

async function emit(type: string, payload: Record<string, unknown>) {
  return t.admin
    .insertInto('outboxEvents')
    .values({ type, organizationId: null, workspaceId: null, payload: JSON.stringify(payload), lastError: null })
    .returning('id')
    .executeTakeFirstOrThrow();
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
};

beforeAll(async () => {
  t = await createTestDatabase();
  connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<JobData>('email', {
    connection,
    prefix,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, backoff: { type: 'fixed', delay: 100 } },
  });
}, 60_000);

afterAll(async () => {
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await connection?.quit();
  await t?.destroy();
});

describe('outbox relay', () => {
  it('publishes events to the mapped queue, marks them published, and ignores them afterwards', async () => {
    const a = await emit('user.email_verification_requested.v1', { userId: uid, email: 'a@x.com', token: 'tok-a' });
    const b = await emit('user.registered.v1', { userId: uid, email: 'a@x.com', name: 'A' }); // no consumer queue yet

    const r1 = await relayOnce(t.db, { email: queue });
    expect(r1).toEqual({ claimed: 2, published: 2, failed: 0 });

    const job = await queue.getJob(a.id);
    expect(job?.data.type).toBe('user.email_verification_requested.v1');
    expect(await queue.getJob(b.id)).toBeUndefined(); // unmapped event: published without a job

    const rows = await t.admin.selectFrom('outboxEvents').select(['id', 'publishedAt']).execute();
    expect(rows.every((x) => x.publishedAt !== null)).toBe(true);

    const r2 = await relayOnce(t.db, { email: queue });
    expect(r2.claimed).toBe(0);
  });

  it('two relays running concurrently never double-publish an event', async () => {
    await t.admin.deleteFrom('outboxEvents').execute();
    const ids = [];
    for (let i = 0; i < 20; i++) {
      ids.push((await emit('member.invited.v1', {
        organizationId: uid, invitationId: uid, email: `u${i}@x.com`, role: 'DEVELOPER',
        token: `t${i}`, invitedByUserId: uid, organizationName: 'Org',
      })).id);
    }
    const results = await Promise.all([
      relayOnce(t.db, { email: queue }, 7),
      relayOnce(t.db, { email: queue }, 7),
      relayOnce(t.db, { email: queue }, 7),
      relayOnce(t.db, { email: queue }, 7),
    ]);
    await relayOnce(t.db, { email: queue }, 20);
    const published = await t.admin.selectFrom('outboxEvents').select('id').where('publishedAt', 'is not', null).execute();
    expect(published).toHaveLength(20);
    expect(results.reduce((n, r) => n + r.claimed, 0)).toBeLessThanOrEqual(20);
    for (const id of ids) expect(await queue.getJob(id)).toBeTruthy();
  });

  it('records the error and retries when enqueueing fails; invalid payloads never leave the DB', async () => {
    await t.admin.deleteFrom('outboxEvents').execute();
    const bad = await emit('member.invited.v1', { nonsense: true });
    const res = await relayOnce(t.db, { email: queue });
    expect(res).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    const row = await t.admin.selectFrom('outboxEvents').select(['publishedAt', 'lastError', 'attempts', 'lockedAt']).where('id', '=', bad.id).executeTakeFirstOrThrow();
    expect(row.publishedAt).toBeNull();
    expect(row.lastError).toBeTruthy();
    expect(row.attempts).toBe(1);
    expect(row.lockedAt).toBeNull(); // released so a later pass can retry

    // missing queue config is also a recorded failure rather than a silent drop
    await t.admin.deleteFrom('outboxEvents').execute();
    await emit('user.password_reset_requested.v1', { userId: uid, email: 'q@x.com', token: 'tt' });
    const res2 = await relayOnce(t.db, {});
    expect(res2.failed).toBe(1);
  });

  it('app_user cannot read the outbox directly (only the definer functions)', async () => {
    await expect(
      withContext(t.db, {}, (trx) => trx.selectFrom('outboxEvents').selectAll().execute()),
    ).rejects.toThrow(/permission denied/);
    // sanity: the function path still works
    const r = await withContext(t.db, {}, (trx) => sql`SELECT count(*) FROM outbox_claim(0)`.execute(trx));
    expect(r.rows).toHaveLength(1);
  });
});

describe('email worker', () => {
  it('sends verification, reset and invitation emails with working links', async () => {
    await t.admin.deleteFrom('outboxEvents').execute();
    await t.admin.deleteFrom('processedEvents').execute();
    await queue.drain();
    const mailer = new FakeMailer();
    const worker = new Worker<JobData>('email', createEmailProcessor({ db: t.db, mailer, appUrl: 'https://app.test' }), {
      connection: connection.duplicate({ maxRetriesPerRequest: null }),
      prefix,
    });
    try {
      await emit('user.email_verification_requested.v1', { userId: uid, email: 'v@x.com', token: 'verify tok/1' });
      await emit('user.password_reset_requested.v1', { userId: uid, email: 'r@x.com', token: 'reset-tok' });
      await emit('member.invited.v1', {
        organizationId: uid, invitationId: uid, email: 'i@x.com', role: 'PROJECT_MANAGER',
        token: 'inv-tok', invitedByUserId: uid, organizationName: 'Acme <script>',
      });
      await relayOnce(t.db, { email: queue });
      await until(() => mailer.sent.length === 3);

      const by = Object.fromEntries(mailer.sent.map((m) => [m.to, m]));
      expect(by['v@x.com']!.text).toContain('https://app.test/verify-email?token=verify%20tok%2F1');
      expect(by['r@x.com']!.text).toContain('https://app.test/reset-password?token=reset-tok');
      expect(by['i@x.com']!.text).toContain('https://app.test/accept-invite?token=inv-tok');
      // untrusted values are HTML-escaped
      expect(by['i@x.com']!.html).not.toContain('<script>');
      expect(by['i@x.com']!.html).toContain('&lt;script&gt;');
    } finally {
      await worker.close();
    }
  });

  it('is idempotent: a duplicate delivery of the same event sends nothing', async () => {
    const mailer = new FakeMailer();
    const processor = createEmailProcessor({ db: t.db, mailer, appUrl: 'https://app.test' });
    const eventId = randomUUID();
    const job = {
      data: { eventId, type: 'user.email_verification_requested.v1', payload: { userId: uid, email: 'dup@x.com', token: 'x' } },
    } as never;
    expect(await processor(job)).toBe('sent');
    expect(await processor(job)).toBe('duplicate');
    expect(mailer.sent).toHaveLength(1);
  });

  it('failed jobs are retried and eventually succeed exactly once', async () => {
    await t.admin.deleteFrom('outboxEvents').execute();
    const mailer = new FakeMailer();
    mailer.failTimes = 2;
    const worker = new Worker<JobData>('email', createEmailProcessor({ db: t.db, mailer, appUrl: 'https://app.test' }), {
      connection: connection.duplicate({ maxRetriesPerRequest: null }),
      prefix,
    });
    try {
      const ev = await emit('user.password_reset_requested.v1', { userId: uid, email: 'retry@x.com', token: 'rt' });
      await relayOnce(t.db, { email: queue });
      await until(() => mailer.sent.some((m) => m.to === 'retry@x.com'));
      expect(mailer.sent.filter((m) => m.to === 'retry@x.com')).toHaveLength(1);
      const job = await queue.getJob(ev.id);
      expect(job?.attemptsMade).toBe(3); // 2 failures + 1 success
    } finally {
      await worker.close();
    }
  });

  it('exhausted jobs stay in the failed set (inspectable / dead-letter candidates)', async () => {
    await t.admin.deleteFrom('outboxEvents').execute();
    const mailer = new FakeMailer();
    mailer.failTimes = 99;
    const worker = new Worker<JobData>('email', createEmailProcessor({ db: t.db, mailer, appUrl: 'https://app.test' }), {
      connection: connection.duplicate({ maxRetriesPerRequest: null }),
      prefix,
    });
    try {
      const ev = await emit('user.password_reset_requested.v1', { userId: uid, email: 'dead@x.com', token: 'dd' });
      await relayOnce(t.db, { email: queue });
      await until(async () => (await queue.getJob(ev.id))?.attemptsMade === 5, 15_000);
      await until(async () => (await queue.getFailedCount()) >= 1);
      expect(mailer.sent.some((m) => m.to === 'dead@x.com')).toBe(false);
    } finally {
      await worker.close();
    }
  }, 30_000);
});
