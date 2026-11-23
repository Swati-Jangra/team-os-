import { sql, withContext, type Database, type Tx } from '@teamos/database';
import { AIProviderError, EMAIL_EXTRACTION_PROMPT, meetingExtractionSchema, parseModelJson, type AIProvider } from '@teamos/ai-core';
import { GoogleError, decryptSecret, encryptSecret, extractTaskKeys, type GoogleClient } from '@teamos/integrations';

export interface GoogleDeps {
  db: Database;
  google: GoogleClient;
  ai: AIProvider;
  key: Buffer;
  log?: (m: string) => void;
  now?: () => Date;
}

/** What is stored (encrypted) in integration_tokens for Google: the refresh token is the long-lived credential. */
export interface TokenBlob { accessToken: string; refreshToken: string | null; expiresAt: number }
export const encodeTokenBlob = (b: TokenBlob) => JSON.stringify(b);

const REFRESH_SKEW_MS = 60_000;
const CAL_PAST_DAYS = 14;
const CAL_FUTURE_DAYS = 90;
const MAIL_FIRST_RUN_DAYS = 7;
const MAIL_OVERLAP_MS = 60 * 60_000;
const MAIL_MAX_PER_RUN = 20;
const MODEL_INPUT_CHARS = 8000;

export type GoogleResult = { status: 'synced' | 'skipped'; reason?: string; changed?: number; removed?: number; messages?: number };

interface Ctx { orgId: string; integrationId: string }

/** Returns a usable access token, refreshing (and persisting) it when it is about to expire. null = integration needs a person. */
async function accessToken(deps: GoogleDeps, c: Ctx, row: { tokenEnc: string | null }): Promise<string | null> {
  if (!row.tokenEnc) return null;
  const aad = `token:${c.integrationId}`;
  const blob = JSON.parse(decryptSecret(row.tokenEnc, deps.key, aad)) as TokenBlob;
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (blob.expiresAt - REFRESH_SKEW_MS > now) return blob.accessToken;
  if (!blob.refreshToken) {
    await markError(deps, c, 'Google access expired and no refresh token is stored. Reconnect.');
    return null;
  }
  try {
    const r = await deps.google.refresh(blob.refreshToken, now);
    const next = encryptSecret(encodeTokenBlob({ ...blob, accessToken: r.accessToken, expiresAt: r.expiresAt }), deps.key, aad);
    await withContext(deps.db, { orgId: c.orgId }, async (trx) => {
      // never resurrect a credential the user deleted while we were refreshing
      const alive = await trx.selectFrom('integrations').select('status').where('id', '=', c.integrationId).executeTakeFirst();
      if (alive?.status === 'CONNECTED') await trx.updateTable('integrationTokens').set({ tokenEnc: next, updatedAt: new Date() }).where('integrationId', '=', c.integrationId).execute();
    });
    return r.accessToken;
  } catch (e) {
    if (e instanceof GoogleError && e.code === 'UNAUTHORIZED') {
      await markError(deps, c, 'Google access was revoked or expired. Reconnect.');
      return null;
    }
    throw e; // retryable (network / 5xx): BullMQ backs off
  }
}

async function markError(deps: GoogleDeps, c: Ctx, message: string) {
  await withContext(deps.db, { orgId: c.orgId }, (trx) =>
    trx.updateTable('integrations').set({ status: 'ERROR', lastError: message, updatedAt: new Date() }).where('id', '=', c.integrationId).where('status', '=', 'CONNECTED').execute());
}

/** Common failure policy: revoked → integration ERROR (no retry storm); retryable → rethrow for BullMQ; other → recorded on the source. */
async function handleError(deps: GoogleDeps, c: Ctx, table: 'calendarSources' | 'emailSources', sourceId: string, e: unknown): Promise<GoogleResult> {
  if (!(e instanceof GoogleError)) throw e;
  if (e.code === 'UNAUTHORIZED') {
    await markError(deps, c, 'Google access was revoked or expired. Reconnect.');
    return { status: 'skipped', reason: 'unauthorized' };
  }
  await withContext(deps.db, { orgId: c.orgId }, (trx) => trx.updateTable(table).set({ lastError: e.message.slice(0, 300) }).where('id', '=', sourceId).execute());
  if (e.retryable) throw e;
  return { status: 'skipped', reason: e.code.toLowerCase() };
}

// ------------------------------------------------------------------------------------------------ calendar

interface CalState { id: string; organizationId: string; workspaceId: string; integrationId: string; calendarId: string; syncToken: string | null; active: boolean; integrationStatus: string; tokenEnc: string | null }

const loadCalendar = (deps: GoogleDeps, orgId: string, id: string) =>
  withContext(deps.db, { orgId }, (trx) =>
    trx.selectFrom('calendarSources as s').innerJoin('integrations as i', 'i.id', 's.integrationId').leftJoin('integrationTokens as t', 't.integrationId', 's.integrationId')
      .select(['s.id', 's.organizationId', 's.workspaceId', 's.integrationId', 's.calendarId', 's.syncToken', 's.active', 'i.status as integrationStatus', 't.tokenEnc'])
      .where('s.id', '=', id).executeTakeFirst() as Promise<CalState | undefined>);

export async function syncCalendar(deps: GoogleDeps, orgId: string, sourceId: string): Promise<GoogleResult> {
  const now = (deps.now ?? (() => new Date()))();
  const s = await loadCalendar(deps, orgId, sourceId);
  if (!s) return { status: 'skipped', reason: 'not found' };
  if (!s.active || s.integrationStatus !== 'CONNECTED') return { status: 'skipped', reason: 'disconnected' };
  const c = { orgId, integrationId: s.integrationId };
  const token = await accessToken(deps, c, s);
  if (!token) return { status: 'skipped', reason: 'needs reconnect' };

  const window = { timeMin: new Date(now.getTime() - CAL_PAST_DAYS * 864e5).toISOString(), timeMax: new Date(now.getTime() + CAL_FUTURE_DAYS * 864e5).toISOString() };
  let page;
  let full = !s.syncToken;
  try {
    try {
      page = await deps.google.listEvents(token, s.calendarId, s.syncToken ? { syncToken: s.syncToken } : window);
    } catch (e) {
      if (!(e instanceof GoogleError && e.code === 'GONE' && s.syncToken)) throw e;
      full = true; // the sync token expired: start over rather than guess what we missed
      page = await deps.google.listEvents(token, s.calendarId, window);
    }
  } catch (e) {
    return handleError(deps, c, 'calendarSources', s.id, e);
  }

  return withContext(deps.db, { orgId }, async (trx) => {
    // disconnect (or removing the calendar) while we were talking to Google wins: re-check under a lock before writing
    const live = await trx.selectFrom('calendarSources as s').innerJoin('integrations as i', 'i.id', 's.integrationId').select(['s.active', 'i.status'])
      .where('s.id', '=', s.id).forUpdate('s').executeTakeFirst();
    if (!live || !live.active || live.status !== 'CONNECTED') return { status: 'skipped', reason: 'disconnected during sync' } as GoogleResult;
    let changed = 0;
    for (let off = 0; off < page.events.length; off += 200) {
      const batch = page.events.slice(off, off + 200);
      const r = await trx.insertInto('calendarEvents').values(batch.map((e) => ({
        organizationId: orgId, workspaceId: s.workspaceId, sourceId: s.id, externalId: e.externalId, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt,
        allDay: e.allDay, status: e.status, htmlLink: e.htmlLink, attendeeCount: e.attendeeCount, syncedAt: now,
      }))).onConflict((oc) => oc.columns(['sourceId', 'externalId']).doUpdateSet((eb) => ({
        title: eb.ref('excluded.title'), startsAt: eb.ref('excluded.startsAt'), endsAt: eb.ref('excluded.endsAt'), allDay: eb.ref('excluded.allDay'),
        status: eb.ref('excluded.status'), htmlLink: eb.ref('excluded.htmlLink'), attendeeCount: eb.ref('excluded.attendeeCount'), syncedAt: now,
      }))).execute();
      changed += r.reduce((n, x) => n + Number(x.numInsertedOrUpdatedRows ?? 0), 0);
    }
    let removed = 0;
    if (page.cancelledIds.length) {
      removed += Number((await trx.deleteFrom('calendarEvents').where('sourceId', '=', s.id).where('externalId', 'in', page.cancelledIds).executeTakeFirst()).numDeletedRows);
    }
    if (full && page.nextSyncToken) {
      // a COMPLETE full listing: anything we hold that Google no longer returned (deleted or outside the window) goes
      const keep = page.events.map((e) => e.externalId);
      let q = trx.deleteFrom('calendarEvents').where('sourceId', '=', s.id);
      if (keep.length) q = q.where('externalId', 'not in', keep);
      removed += Number((await q.executeTakeFirst()).numDeletedRows);
    }
    await trx.updateTable('calendarSources').set({ syncToken: page.nextSyncToken, lastSyncedAt: now, lastError: null }).where('id', '=', s.id).execute();
    await trx.updateTable('integrations').set({ lastSyncedAt: now, lastError: null, updatedAt: now }).where('id', '=', s.integrationId).execute();
    if (changed || removed) {
      await trx.insertInto('outboxEvents').values({ type: 'calendar.synced.v1', version: 1, organizationId: orgId, workspaceId: s.workspaceId, lastError: null, payload: JSON.stringify({ organizationId: orgId, workspaceId: s.workspaceId, sourceId: s.id }) }).execute();
    }
    return { status: 'synced', changed, removed } as GoogleResult;
  });
}

// ------------------------------------------------------------------------------------------------ mail

interface MailState { id: string; organizationId: string; workspaceId: string; projectId: string | null; integrationId: string; label: string; syncedUntil: Date | null; active: boolean; integrationStatus: string; tokenEnc: string | null }

const loadMailbox = (deps: GoogleDeps, orgId: string, id: string) =>
  withContext(deps.db, { orgId }, (trx) =>
    trx.selectFrom('emailSources as s').innerJoin('integrations as i', 'i.id', 's.integrationId').leftJoin('integrationTokens as t', 't.integrationId', 's.integrationId')
      .select(['s.id', 's.organizationId', 's.workspaceId', 's.projectId', 's.integrationId', 's.label', 's.syncedUntil', 's.active', 'i.status as integrationStatus', 't.tokenEnc'])
      .where('s.id', '=', id).executeTakeFirst() as Promise<MailState | undefined>);

/** Project for a message: an explicit task key ("APO-12") in the subject/body wins, else the mailbox's default project. Always inside ONE workspace. */
async function projectFor(trx: Tx, s: MailState, text: string): Promise<string | null> {
  for (const k of extractTaskKeys(text)) {
    const r = await sql<{ id: string | null }>`SELECT job_find_project(${s.organizationId}::uuid, ${s.workspaceId}::uuid, ${k.key}) AS id`.execute(trx);
    if (r.rows[0]?.id) return r.rows[0].id;
  }
  return s.projectId;
}

export async function syncMailbox(deps: GoogleDeps, orgId: string, sourceId: string): Promise<GoogleResult> {
  const now = (deps.now ?? (() => new Date()))();
  const s = await loadMailbox(deps, orgId, sourceId);
  if (!s) return { status: 'skipped', reason: 'not found' };
  if (!s.active || s.integrationStatus !== 'CONNECTED') return { status: 'skipped', reason: 'disconnected' };
  const c = { orgId, integrationId: s.integrationId };
  const token = await accessToken(deps, c, s);
  if (!token) return { status: 'skipped', reason: 'needs reconnect' };

  const since = s.syncedUntil ? s.syncedUntil.getTime() - MAIL_OVERLAP_MS : now.getTime() - MAIL_FIRST_RUN_DAYS * 864e5;
  let fetched;
  try {
    const ids = await deps.google.listMessageIds(token, s.label, since / 1000, 50);
    const known = ids.length
      ? new Set((await withContext(deps.db, { orgId }, (trx) => trx.selectFrom('emailMessages').select('externalId').where('sourceId', '=', s.id).where('externalId', 'in', ids).execute())).map((r) => r.externalId))
      : new Set<string>();
    fetched = [];
    for (const id of ids.filter((i) => !known.has(i)).slice(0, MAIL_MAX_PER_RUN)) {
      const m = await deps.google.getMessage(token, id);
      if (m) fetched.push(m);
    }
  } catch (e) {
    return handleError(deps, c, 'emailSources', s.id, e);
  }

  const created = await withContext(deps.db, { orgId }, async (trx) => {
    const live = await trx.selectFrom('emailSources as s').innerJoin('integrations as i', 'i.id', 's.integrationId').select(['s.active', 'i.status'])
      .where('s.id', '=', s.id).forUpdate('s').executeTakeFirst();
    if (!live || !live.active || live.status !== 'CONNECTED') return null;
    const out: Array<{ id: string; subject: string; excerpt: string }> = [];
    for (const m of fetched) {
      const projectId = await projectFor(trx, s, `${m.subject}\n${m.excerpt}`);
      const row = await trx.insertInto('emailMessages').values({
        organizationId: orgId, workspaceId: s.workspaceId, sourceId: s.id, externalId: m.externalId, threadId: m.threadId, subject: m.subject, fromAddress: m.from,
        receivedAt: m.receivedAt, excerpt: m.excerpt, projectId, linkSource: projectId ? 'AUTO' : null, syncedAt: now,
      }).onConflict((oc) => oc.columns(['sourceId', 'externalId']).doNothing()).returning('id').executeTakeFirst();
      if (row) out.push({ id: row.id, subject: m.subject, excerpt: m.excerpt });
    }
    await trx.updateTable('emailSources').set({ syncedUntil: now, lastSyncedAt: now, lastError: null }).where('id', '=', s.id).execute();
    await trx.updateTable('integrations').set({ lastSyncedAt: now, lastError: null, updatedAt: now }).where('id', '=', s.integrationId).execute();
    return out;
  });
  if (!created) return { status: 'skipped', reason: 'disconnected during sync' };

  for (const m of created) await extractMessage(deps, s, m); // after commit: a model outage never loses the ingested mail
  return { status: 'synced', messages: created.length };
}

/** Decisions and action items are PROPOSED here (PENDING). Nothing becomes a task until a person approves it through the API. */
async function extractMessage(deps: GoogleDeps, s: MailState, m: { id: string; subject: string; excerpt: string }): Promise<void> {
  const emit = (trx: Tx) => trx.insertInto('outboxEvents').values({ type: 'email.processed.v1', version: 1, organizationId: s.organizationId, workspaceId: s.workspaceId, lastError: null, payload: JSON.stringify({ organizationId: s.organizationId, workspaceId: s.workspaceId, messageId: m.id }) }).execute();
  const fail = (reason: string) => withContext(deps.db, { orgId: s.organizationId }, async (trx) => {
    await trx.updateTable('emailMessages').set({ status: 'FAILED', failureReason: reason.slice(0, 300) }).where('id', '=', m.id).execute();
    await emit(trx);
  });
  if (!m.excerpt.trim()) return void (await fail('The message has no readable text.'));
  let extraction;
  let usage = { model: 'unknown', inT: 0, outT: 0 };
  try {
    const r = await deps.ai.chat({
      json: true, temperature: 0, maxTokens: 1500,
      messages: [
        { role: 'system', content: EMAIL_EXTRACTION_PROMPT },
        { role: 'user', content: `Email subject: ${m.subject}\n\n<transcript>\n${m.excerpt.slice(0, MODEL_INPUT_CHARS)}\n</transcript>` },
      ],
    });
    usage = { model: r.model, inT: r.usage.inputTokens, outT: r.usage.outputTokens };
    extraction = parseModelJson(meetingExtractionSchema, r.text);
  } catch (e) {
    if (e instanceof AIProviderError && e.retryable) return void (await fail('The AI service was unavailable.'));
    deps.log?.(`email ${m.id}: unusable model output (${(e as Error).name})`);
    return void (await fail('The AI returned a response that could not be understood.'));
  }
  const rows = [
    ...extraction.decisions.map((d) => ({ kind: 'DECISION' as const, text: d.text, assigneeHint: null, dueDate: null, priority: null })),
    ...extraction.actionItems.map((a) => ({ kind: 'ACTION_ITEM' as const, text: a.text, assigneeHint: a.assigneeName ?? null, dueDate: a.dueDate ?? null, priority: a.priority ?? null })),
  ];
  await withContext(deps.db, { orgId: s.organizationId }, async (trx) => {
    await trx.deleteFrom('emailItems').where('messageId', '=', m.id).where('status', '=', 'PENDING').execute();
    if (rows.length) await trx.insertInto('emailItems').values(rows.map((r) => ({ ...r, organizationId: s.organizationId, workspaceId: s.workspaceId, messageId: m.id }))).execute();
    await trx.updateTable('emailMessages').set({ status: 'EXTRACTED', summary: extraction.summary || null, failureReason: null }).where('id', '=', m.id).execute();
    await trx.insertInto('aiUsage').values({ organizationId: s.organizationId, userId: null, feature: 'email_extraction', provider: deps.ai.name, model: usage.model, inputTokens: usage.inT, outputTokens: usage.outT }).execute();
    await emit(trx);
  });
}

// ------------------------------------------------------------------------------------------------ scheduling

async function all(deps: GoogleDeps, fn: 'job_sync_calendars' | 'job_sync_mailboxes', run: (orgId: string, id: string) => Promise<GoogleResult>) {
  const rows = await withContext(deps.db, {}, (trx) => sql<{ organizationId: string; sourceId: string }>`SELECT organization_id AS "organizationId", source_id AS "sourceId" FROM ${sql.raw(fn)}()`.execute(trx));
  let synced = 0, failed = 0;
  for (const r of rows.rows) {
    try {
      if ((await run(r.organizationId, r.sourceId)).status === 'synced') synced++;
    } catch (e) {
      failed++;
      deps.log?.(`${fn} ${r.sourceId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { sources: rows.rows.length, synced, failed };
}
export const syncAllCalendars = (deps: GoogleDeps) => all(deps, 'job_sync_calendars', (o, i) => syncCalendar(deps, o, i));
export const syncAllMailboxes = (deps: GoogleDeps) => all(deps, 'job_sync_mailboxes', (o, i) => syncMailbox(deps, o, i));
