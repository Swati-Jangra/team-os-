import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Queue } from 'bullmq';
import { sql, withContext, type Database } from '@teamos/database';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export interface ObservabilityDeps {
  db: Database;
  queues: Record<string, Pick<Queue, 'getJobCounts'>>;
  redisPing: () => Promise<boolean>;
  metricsToken?: string | null;
}

/**
 * Tiny HTTP listener for orchestrators and Prometheus. Not part of the public API surface:
 * bind it to the private network only (docs/DEPLOYMENT.md).
 *   GET /health/live   process is up
 *   GET /health/ready  Postgres + Redis reachable
 *   GET /metrics       bearer-token protected; 404 when no token is configured
 */
export function createWorkerObservability(deps: ObservabilityDeps) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'teamos_worker_' });
  const collectErrors = new Counter({ name: 'teamos_metrics_collect_errors_total', help: 'Scrape-time collectors that failed (the rest of /metrics is still served)', labelNames: ['collector'] as const, registers: [registry] });
  /** A failing collector (DB or Redis down) must not take the whole scrape down: that is when metrics matter most. */
  const safe = (name: string, fn: () => Promise<void>) => async () => { try { await fn(); } catch { collectErrors.inc({ collector: name }); } };
  const jobs = new Counter({ name: 'teamos_worker_jobs_total', help: 'Jobs finished, by queue and outcome', labelNames: ['queue', 'outcome'] as const, registers: [registry] });
  const depth = new Gauge({
    name: 'teamos_queue_jobs', help: 'Jobs currently in each state per queue', labelNames: ['queue', 'state'] as const, registers: [registry],
    collect() {
      return safe('queues', async () => {
        for (const [name, q] of Object.entries(deps.queues)) {
          const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
          for (const [state, n] of Object.entries(c)) this.set({ queue: name, state }, n);
        }
      })();
    },
  });
  void depth;
  const backlog = new Gauge({
    name: 'teamos_outbox_pending', help: 'Outbox events not yet published', registers: [registry],
    collect() { return safe('outbox', async () => this.set((await outboxStats(deps.db)).pending))(); },
  });
  void backlog;
  new Gauge({
    name: 'teamos_outbox_oldest_pending_seconds', help: 'Age of the oldest unpublished outbox event (relay lag)', registers: [registry],
    collect() { return safe('outbox', async () => this.set((await outboxStats(deps.db)).oldestPendingSeconds))(); },
  });
  new Gauge({
    name: 'teamos_outbox_retrying', help: 'Unpublished outbox events that have failed at least once', registers: [registry],
    collect() { return safe('outbox', async () => this.set((await outboxStats(deps.db)).retrying))(); },
  });

  const ready = async () => {
    const database = await sql`SELECT 1`.execute(deps.db).then(() => true, () => false);
    const redis = await deps.redisPing().catch(() => false);
    return { ok: database && redis, checks: { database, redis } };
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (url === '/health/live') return json(200, { status: 'live' });
    if (url === '/health/ready') return void ready().then((r) => json(r.ok ? 200 : 503, { status: r.ok ? 'ready' : 'unavailable', checks: r.checks }));
    if (url === '/metrics') {
      const expected = deps.metricsToken;
      if (!expected) { res.writeHead(404); return void res.end(); }
      const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /i, ''));
      const want = Buffer.from(expected);
      if (given.length !== want.length || !timingSafeEqual(given, want)) { res.writeHead(401, { 'www-authenticate': 'Bearer' }); return void res.end(); }
      return void registry.metrics().then((body) => { res.writeHead(200, { 'content-type': registry.contentType }); res.end(body); }, () => json(500, { error: 'metrics_failed' }));
    }
    json(404, { error: 'not_found' });
  });

  return {
    registry,
    server,
    jobFinished: (queue: string, outcome: 'completed' | 'failed') => jobs.inc({ queue, outcome }),
    listen: (port: number, host = '0.0.0.0') => new Promise<Server>((resolve) => server.listen(port, host, () => resolve(server))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function outboxStats(db: Database) {
  const r = await withContext(db, {}, (trx) =>
    sql<{ pending: string; oldestPendingSeconds: number; retrying: string }>`SELECT pending, oldest_pending_seconds AS "oldestPendingSeconds", retrying FROM outbox_stats()`.execute(trx),
  );
  const row = r.rows[0]!;
  return { pending: Number(row.pending), oldestPendingSeconds: Number(row.oldestPendingSeconds), retrying: Number(row.retrying) };
}
