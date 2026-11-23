import type { Job } from 'bullmq';
import type { Database } from '@teamos/database';
import { parseEventPayload, type EventType } from '@teamos/event-contracts';
import type { Mailer } from './mailer';
import type { JobData } from './queues';
import { invitationMessage, passwordResetMessage, verifyEmailMessage } from './templates';

export const EMAIL_CONSUMER = 'email';

/**
 * Sends the transactional email for an event. Idempotent: a processed_events row (consumer, event id)
 * is written after a successful send, and checked first, so duplicate deliveries of the same
 * event don't send twice. (A crash between send and record can still duplicate once — acceptable for email.)
 */
export function createEmailProcessor(deps: { db: Database; mailer: Mailer; appUrl: string }) {
  return async function process(job: Job<JobData>): Promise<'sent' | 'duplicate'> {
    const { eventId, type, payload } = job.data;

    const done = await deps.db
      .selectFrom('processedEvents')
      .select('eventId')
      .where('consumer', '=', EMAIL_CONSUMER)
      .where('eventId', '=', eventId)
      .executeTakeFirst();
    if (done) return 'duplicate';

    const t = type as EventType;
    let message;
    switch (t) {
      case 'user.email_verification_requested.v1':
        message = verifyEmailMessage(parseEventPayload(t, payload), deps.appUrl);
        break;
      case 'user.password_reset_requested.v1':
        message = passwordResetMessage(parseEventPayload(t, payload), deps.appUrl);
        break;
      case 'member.invited.v1':
        message = invitationMessage(parseEventPayload(t, payload), deps.appUrl);
        break;
      default:
        throw new Error(`email processor cannot handle ${type}`);
    }

    await deps.mailer.send(message);
    await deps.db
      .insertInto('processedEvents')
      .values({ consumer: EMAIL_CONSUMER, eventId })
      .onConflict((oc) => oc.columns(['consumer', 'eventId']).doNothing())
      .execute();
    return 'sent';
  };
}
