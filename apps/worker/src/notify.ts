import { createHash } from 'node:crypto';
import { sql, withContext, type Database, type NotificationCategory } from '@teamos/database';
import { rtUserChannel, type RealtimeMessage } from '@teamos/event-contracts';
import { effectivePreference } from '@teamos/validation';
import type { Mailer } from './mailer';
import type { Publisher } from './realtime';
import { notificationMessage } from './templates';

export interface NotifyDeps {
  db: Database;
  mailer: Mailer;
  publisher: Publisher;
  appUrl: string;
  log?: (m: string) => void;
}

export interface Delivery {
  orgId: string;
  workspaceId: string;
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string | null;
  /** App-relative link, e.g. /o/<org>/projects/<id>?task=<id> */
  link: string;
  taskId: string | null;
  /** Makes delivery idempotent: re-processing the same event/job never notifies twice. */
  dedupeKey: string;
}

export type DeliveryResult = 'skipped' | 'duplicate' | 'delivered';

/**
 * Delivers one notification to one user, honouring their preferences and their CURRENT access:
 * someone who left the org or lost access to the workspace is never notified (and never emailed).
 * Runs under the recipient's own RLS context, so it can only ever read/write what that user could.
 */
export async function deliver(deps: NotifyDeps, d: Delivery): Promise<DeliveryResult> {
  const ctx = { userId: d.userId, orgId: d.orgId };

  const prep = await withContext(deps.db, ctx, async (trx) => {
    const access = await sql<{ ok: boolean }>`
      SELECT (app_is_org_member(${d.orgId}::uuid, ${d.userId}::uuid)
              AND app_can_see_workspace(${d.orgId}::uuid, ${d.workspaceId}::uuid)) AS ok`.execute(trx);
    if (!access.rows[0]?.ok) return null;
    const prefs = await trx.selectFrom('notificationPreferences').select(['category', 'inApp', 'email']).execute();
    const pref = effectivePreference(d.category, prefs);
    const user = await trx.selectFrom('users').select(['email']).where('id', '=', d.userId).where('deletedAt', 'is', null).executeTakeFirst();
    return user ? { pref, email: user.email } : null;
  });
  if (!prep || (!prep.pref.inApp && !prep.pref.email)) return 'skipped';

  let result: DeliveryResult = 'duplicate';
  if (prep.pref.inApp) {
    const row = await withContext(deps.db, ctx, (trx) =>
      trx
        .insertInto('notifications')
        .values({
          organizationId: d.orgId,
          userId: d.userId,
          category: d.category,
          title: d.title,
          body: d.body,
          link: d.link,
          workspaceId: d.workspaceId,
          taskId: d.taskId,
          dedupeKey: d.dedupeKey,
        })
        .onConflict((oc) => oc.columns(['userId', 'dedupeKey']).doNothing())
        .returning('id')
        .executeTakeFirst(),
    );
    if (row) {
      result = 'delivered';
      const msg: RealtimeMessage = { k: 'notification', notification: { id: row.id, category: d.category, title: d.title, link: d.link } };
      await deps.publisher.publish(rtUserChannel(d.userId), msg).catch((e) => deps.log?.(`realtime publish failed: ${e}`));
    }
  } else {
    result = 'delivered';
  }

  if (prep.pref.email) {
    // Runs even when the in-app row already existed (a retry after an email failure must still send).
    // Same pattern as the transactional email processor: check -> send -> record. A failed send leaves no
    // record, so the retry sends; a crash between send and record can at worst duplicate one email.
    const consumer = `notif-email:${d.userId}`;
    const eventId = dedupeToUuid(d.dedupeKey);
    const already = await deps.db.selectFrom('processedEvents').select('eventId').where('consumer', '=', consumer).where('eventId', '=', eventId).executeTakeFirst();
    if (!already) {
      await deps.mailer.send(notificationMessage({ to: prep.email, title: d.title, body: d.body, url: `${deps.appUrl}${d.link}` }));
      await deps.db.insertInto('processedEvents').values({ consumer, eventId }).onConflict((oc) => oc.columns(['consumer', 'eventId']).doNothing()).execute();
    }
  }
  return result;
}

/** processed_events.event_id is a uuid; derive a stable one from the dedupe key. */
export function dedupeToUuid(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
