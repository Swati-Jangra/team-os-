import { Injectable } from '@nestjs/common';
import type { Tx } from '@teamos/database';
import { parseEventPayload, type EventPayload, type EventType } from '@teamos/event-contracts';

/**
 * Transactional outbox writer. Always called with the SAME transaction as the business
 * mutation, so an event exists if and only if the change committed. The worker relays rows
 * to BullMQ (at-least-once; consumers are idempotent).
 */
@Injectable()
export class OutboxService {
  async enqueue<T extends EventType>(
    trx: Tx,
    type: T,
    payload: EventPayload<T>,
    scope: { orgId?: string | null; workspaceId?: string | null } = {},
  ): Promise<void> {
    const valid = parseEventPayload(type, payload); // fail loudly on contract drift
    const version = Number(/\.v(\d+)$/.exec(type)?.[1] ?? 1);
    await trx
      .insertInto('outboxEvents')
      .values({
        type,
        version,
        organizationId: scope.orgId ?? null,
        workspaceId: scope.workspaceId ?? null,
        payload: JSON.stringify(valid),
        lastError: null,
      })
      .execute();
  }
}
