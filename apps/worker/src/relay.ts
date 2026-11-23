import type { Queue } from 'bullmq';
import { sql, withContext, type Database } from '@teamos/database';
import { EVENT_QUEUE, isEventType, parseEventPayload, rtOrgChannel, toRealtimeHint, type RealtimeMessage } from '@teamos/event-contracts';
import type { JobData, QueueName } from './queues';
import type { Publisher } from './realtime';

interface OutboxRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  organizationId: string | null;
}

export interface RelayResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * One relay pass: claim a batch of unpublished outbox rows (FOR UPDATE SKIP LOCKED inside
 * outbox_claim, so concurrent relays never share a row), enqueue each to BullMQ with
 * jobId = event id (so a re-delivery is a no-op), then mark it published.
 * Delivery is at-least-once: a crash between enqueue and mark simply re-enqueues the same jobId.
 */
export async function relayOnce(
  db: Database,
  queues: Partial<Record<QueueName, Queue<JobData>>>,
  limit = 50,
  log: (msg: string) => void = () => undefined,
  publisher?: Publisher,
): Promise<RelayResult> {
  const claimed = await withContext(db, {}, async (trx) => {
    const r = await sql<OutboxRow>`SELECT id, type, payload, attempts, organization_id AS "organizationId" FROM outbox_claim(${limit})`.execute(trx);
    return r.rows;
  });

  let published = 0;
  let failed = 0;
  for (const ev of claimed) {
    try {
      if (!isEventType(ev.type)) {
        log(`outbox ${ev.id}: unknown event type "${ev.type}" — no consumer, marking published`);
      } else {
        parseEventPayload(ev.type, ev.payload); // contract check before it leaves the DB
        const target = EVENT_QUEUE[ev.type];
        if (target) {
          const queue = queues[target];
          if (!queue) throw new Error(`queue "${target}" is not configured`);
          await queue.add(ev.type, { eventId: ev.id, type: ev.type, payload: ev.payload }, { jobId: ev.id });
        }
        // Live-update hint (best effort: a failed publish must never block or fail the event itself).
        const hint = ev.organizationId && publisher ? toRealtimeHint(ev.type, ev.payload) : null;
        if (hint && ev.organizationId) {
          const msg: RealtimeMessage = { k: 'hint', hint };
          await publisher!.publish(rtOrgChannel(ev.organizationId), msg).catch((e) => log(`realtime publish failed: ${e}`));
        }
      }
      await withContext(db, {}, (trx) => sql`SELECT outbox_mark_published(${ev.id}::uuid)`.execute(trx));
      published++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      log(`outbox ${ev.id} (${ev.type}) failed: ${message}`);
      await withContext(db, {}, (trx) => sql`SELECT outbox_mark_failed(${ev.id}::uuid, ${message})`.execute(trx));
    }
  }
  return { claimed: claimed.length, published, failed };
}

/** Polls until `signal` aborts. Drains immediately while batches are full. */
export async function runRelayLoop(
  db: Database,
  queues: Partial<Record<QueueName, Queue<JobData>>>,
  opts: { intervalMs?: number; batch?: number; signal: AbortSignal; log?: (m: string) => void; publisher?: Publisher },
): Promise<void> {
  const interval = opts.intervalMs ?? 500;
  const batch = opts.batch ?? 50;
  while (!opts.signal.aborted) {
    let drained = false;
    try {
      const r = await relayOnce(db, queues, batch, opts.log, opts.publisher);
      drained = r.claimed < batch;
    } catch (err) {
      opts.log?.(`relay pass failed: ${err instanceof Error ? err.message : String(err)}`);
      drained = true;
    }
    if (drained) await new Promise((res) => setTimeout(res, interval));
  }
}
