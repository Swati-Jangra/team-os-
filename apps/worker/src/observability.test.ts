import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createTestDatabase, sql, withContext, type TestDatabase } from '@teamos/database';
import { createWorkerObservability, outboxStats } from './observability';

let t: TestDatabase;
let base = '';
let obs: ReturnType<typeof createWorkerObservability>;
let redisUp = true;
const TOKEN = 'worker-metrics-token-123456';

beforeAll(async () => {
  t = await createTestDatabase();
  obs = createWorkerObservability({
    db: t.db,
    queues: { email: { getJobCounts: (async () => ({ waiting: 3, active: 1, delayed: 0, failed: 2 })) as never } },
    redisPing: async () => redisUp,
    metricsToken: TOKEN,
  });
  const srv = await obs.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  await obs?.close();
  await t?.destroy();
});

describe('worker observability', () => {
  it('liveness never touches dependencies; readiness does', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    redisUp = false;
    const r = await fetch(`${base}/health/ready`);
    expect(r.status).toBe(503);
    expect((await r.json()).checks).toEqual({ database: true, redis: false });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    redisUp = true;
  });

  it('outbox_stats reports backlog and age without exposing payloads', async () => {
    expect(await outboxStats(t.db)).toMatchObject({ pending: 0, oldestPendingSeconds: 0 });
    await t.admin.insertInto('outboxEvents').values({ type: 'x.v1', payload: JSON.stringify({ secret: 'do-not-leak' }) as never, createdAt: new Date(Date.now() - 120_000) as never }).execute();
    const s = await outboxStats(t.db);
    expect(s.pending).toBe(1);
    expect(s.oldestPendingSeconds).toBeGreaterThan(100);
    // the application role still cannot read the table directly
    await expect(withContext(t.db, {}, (trx) => sql`SELECT payload FROM outbox_events`.execute(trx))).rejects.toThrow(/permission denied/);
  });

  it('/metrics requires the bearer token and exports queue depth, outbox lag and job counters', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    obs.jobFinished('email', 'completed');
    obs.jobFinished('email', 'failed');
    const r = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toMatch(/teamos_queue_jobs\{queue="email",state="waiting"\} 3/);
    expect(text).toMatch(/teamos_queue_jobs\{queue="email",state="failed"\} 2/);
    expect(text).toMatch(/teamos_outbox_pending 1/);
    expect(text).toMatch(/teamos_outbox_oldest_pending_seconds 1\d\d/);
    expect(text).toMatch(/teamos_worker_jobs_total\{queue="email",outcome="failed"\} 1/);
    expect(text).not.toContain('do-not-leak');
  });

  it('/metrics is 404 without a configured token and other methods are refused', async () => {
    const bare = createWorkerObservability({ db: t.db, queues: {}, redisPing: async () => true });
    const srv = await bare.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    expect((await fetch(`${url}/metrics`)).status).toBe(404);
    expect((await fetch(`${url}/health/live`, { method: 'POST' })).status).toBe(405);
    await bare.close();
  });

  it('a failing collector does not break the scrape', async () => {
    const broken = createWorkerObservability({
      db: t.db,
      queues: { email: { getJobCounts: (async () => { throw new Error('redis down'); }) as never } },
      redisPing: async () => true,
      metricsToken: TOKEN,
    });
    const srv = await broken.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/metrics`;
    expect((await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    // the error counter is visible from the next scrape on (it is printed before the failing collector runs)
    const r = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/teamos_metrics_collect_errors_total\{collector="queues"\} 1/);
    await broken.close();
  });
});
