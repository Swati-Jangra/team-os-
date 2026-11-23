import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Tx } from '@teamos/database';
import { hasPermission } from '@teamos/permissions';
import { GOOGLE_SCOPES, GoogleError, decryptSecret, encryptSecret, type GoogleClient } from '@teamos/integrations';
import { AppError } from '@teamos/shared';
import type { ConnectCalendarInput, ConnectMailboxInput } from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import type { AppConfig } from '../../common/app-config';
import type { RateLimiter } from '../../common/rate-limit/rate-limiter';
import { APP_CONFIG, GOOGLE_CLIENT, RATE_LIMITER } from '../../common/tokens';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';

type Provider = 'GOOGLE_CALENDAR' | 'GOOGLE_MAIL';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;
interface TokenBlob { accessToken: string; refreshToken: string | null; expiresAt: number }

const SCOPE: Record<Provider, readonly string[]> = { GOOGLE_CALENDAR: GOOGLE_SCOPES.calendar, GOOGLE_MAIL: GOOGLE_SCOPES.mail };

export interface GoogleIntegrationDto { id: string; provider: Provider; status: 'CONNECTED' | 'ERROR'; accountLogin: string; lastSyncedAt: Date | null; lastError: string | null }

@Injectable()
export class GoogleService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(GOOGLE_CLIENT) private readonly google: GoogleClient | null,
  ) {}

  private get key(): Buffer {
    if (!this.config.integrationKey || !this.google) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Google is not configured on this server.');
    return this.config.integrationKey;
  }
  private gc(): GoogleClient {
    this.key; // eslint-disable-line @typescript-eslint/no-unused-expressions
    return this.google!;
  }
  private ctx = (a: RequestActor) => ({ userId: a.userId, orgId: a.orgId });
  private system = <T>(orgId: string, fn: (trx: Tx) => Promise<T>) => this.dbs.run({ orgId }, fn);
  private get redirectUri() {
    return `${this.config.appUrl}/api/v1/integrations/google/callback`;
  }
  private rethrow(e: unknown): never {
    if (e instanceof AppError) throw e;
    if (e instanceof GoogleError) {
      if (e.code === 'UNAUTHORIZED') throw new AppError('CONFLICT', 'Google access was revoked. Reconnect Google.');
      if (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN') throw new AppError('NOT_FOUND', 'Not found, or the connected Google account cannot access it.');
      if (e.code === 'RATE_LIMITED') throw new AppError('RATE_LIMITED', 'Google rate limit reached. Try again later.');
      throw new AppError('UPSTREAM_ERROR', 'Google returned an error. Please try again.');
    }
    throw e;
  }

  // ------------------------------------------------------------------ overview

  async overview(a: RequestActor) {
    const configured = !!this.config.integrationKey && !!this.google;
    return this.dbs.run(this.ctx(a), async (trx) => {
      const integrations = await trx.selectFrom('integrations').select(['id', 'provider', 'status', 'accountLogin', 'lastSyncedAt', 'lastError'])
        .where('provider', 'in', ['GOOGLE_CALENDAR', 'GOOGLE_MAIL']).where('status', '<>', 'DISCONNECTED').execute();
      const calendars = await trx.selectFrom('calendarSources').select(['id', 'integrationId', 'workspaceId', 'calendarId', 'name', 'lastSyncedAt', 'lastError']).where('active', '=', true).orderBy('name').execute();
      const mailboxes = await trx.selectFrom('emailSources').select(['id', 'integrationId', 'workspaceId', 'projectId', 'label', 'lastSyncedAt', 'lastError']).where('active', '=', true).execute();
      const pick = (p: Provider) => (integrations.find((i) => i.provider === p) as GoogleIntegrationDto | undefined) ?? null;
      return { configured, calendar: { integration: pick('GOOGLE_CALENDAR'), sources: calendars }, mail: { integration: pick('GOOGLE_MAIL'), source: mailboxes[0] ?? null } };
    });
  }

  // ------------------------------------------------------------------ OAuth

  async start(a: RequestActor, kind: 'calendar' | 'mail'): Promise<{ url: string }> {
    const gc = this.gc();
    const provider: Provider = kind === 'calendar' ? 'GOOGLE_CALENDAR' : 'GOOGLE_MAIL';
    const state = randomBytes(32).toString('base64url');
    await this.dbs.db.insertInto('oauthStates').values({ stateHash: sha256(state), organizationId: a.orgId, userId: a.userId, provider, expiresAt: new Date(Date.now() + STATE_TTL_MS) }).execute();
    return { url: gc.authorizeUrl(state, this.redirectUri, SCOPE[provider]) };
  }

  /** Same guarantees as the GitHub callback: single-use state bound to the user, org taken from the state row, role re-checked. */
  async finish(user: UserActor, q: { code?: string; state: string; error?: string }): Promise<{ orgId: string; ok: boolean; error?: string }> {
    const gc = this.gc();
    const row = await this.dbs.db.deleteFrom('oauthStates').where('stateHash', '=', sha256(q.state)).where('userId', '=', user.userId).where('provider', 'in', ['GOOGLE_CALENDAR', 'GOOGLE_MAIL'])
      .returning(['organizationId', 'expiresAt', 'provider']).executeTakeFirst();
    if (!row || row.expiresAt.getTime() < Date.now()) throw new AppError('TOKEN_INVALID', 'This connection attempt expired. Start again.');
    const orgId = row.organizationId;
    const provider = row.provider as Provider;
    if (q.error || !q.code) return { orgId, ok: false, error: 'google_denied' };

    const role = await this.dbs.run({ userId: user.userId, orgId }, (trx) =>
      trx.selectFrom('organizationMembers').select('role').where('userId', '=', user.userId).where('organizationId', '=', orgId).where('deletedAt', 'is', null).executeTakeFirst());
    if (!role || !hasPermission(role.role, 'integration:manage')) throw new AppError('FORBIDDEN');

    let tokens, account: string;
    try {
      tokens = await gc.exchangeCode(q.code, this.redirectUri);
      // Google's consent screen lets people untick scopes: refuse a grant that cannot do the job instead of failing later
      if (!SCOPE[provider].every((s) => tokens!.scope.split(' ').includes(s))) return { orgId, ok: false, error: 'google_scope_missing' };
      // without a refresh token the connection would die within the hour
      if (!tokens.refreshToken) return { orgId, ok: false, error: 'google_no_refresh_token' };
      account = provider === 'GOOGLE_MAIL' ? await gc.getMailAddress(tokens.accessToken) : ((await gc.listCalendars(tokens.accessToken)).find((c) => c.primary)?.id ?? 'google-account');
    } catch (e) {
      return this.rethrow(e);
    }
    const actor = { userId: user.userId, orgId, role: role.role, requestId: user.requestId, ip: user.ip } as RequestActor;
    const integrationId = await this.dbs.run(this.ctx(actor), async (trx) => {
      const existing = await trx.selectFrom('integrations').select('id').where('provider', '=', provider).where('status', '<>', 'DISCONNECTED').forUpdate().executeTakeFirst();
      let id: string;
      const scopes = SCOPE[provider].join(' ');
      if (existing) {
        id = existing.id;
        await trx.updateTable('integrations').set({ status: 'CONNECTED', accountLogin: account, accountId: account, scopes, lastError: null, updatedAt: new Date() }).where('id', '=', id).execute();
      } else {
        id = (await trx.insertInto('integrations').values({ organizationId: orgId, provider, accountLogin: account, accountId: account, scopes, connectedBy: user.userId }).returning('id').executeTakeFirstOrThrow()).id;
      }
      await this.audit.record(trx, this.audit.forActor(actor, { action: 'integration.connected', targetType: 'integration', targetId: id, metadata: { provider, account, scopes } }));
      await this.outbox.enqueue(trx, 'integration.connected.v1', { organizationId: orgId, integrationId: id, actorUserId: user.userId }, { orgId });
      return id;
    });
    const blob: TokenBlob = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
    const enc = encryptSecret(JSON.stringify(blob), this.key, `token:${integrationId}`);
    await this.system(orgId, (trx) => trx.insertInto('integrationTokens').values({ integrationId, organizationId: orgId, tokenEnc: enc })
      .onConflict((oc) => oc.column('integrationId').doUpdateSet({ tokenEnc: enc, updatedAt: new Date() })).execute());
    return { orgId, ok: true };
  }

  /** A usable access token; refreshes (and persists) when it is about to expire. Revoked access flips the integration to ERROR. */
  private async accessToken(orgId: string, integrationId: string): Promise<string> {
    const r = await this.system(orgId, (trx) => trx.selectFrom('integrationTokens').select('tokenEnc').where('integrationId', '=', integrationId).executeTakeFirst());
    if (!r) throw new AppError('CONFLICT', 'Google is not connected.');
    const aad = `token:${integrationId}`;
    const blob = JSON.parse(decryptSecret(r.tokenEnc, this.key, aad)) as TokenBlob;
    if (blob.expiresAt - REFRESH_SKEW_MS > Date.now()) return blob.accessToken;
    if (!blob.refreshToken) throw new AppError('CONFLICT', 'Google access expired. Reconnect Google.');
    try {
      const n = await this.gc().refresh(blob.refreshToken);
      const enc = encryptSecret(JSON.stringify({ ...blob, ...n }), this.key, aad);
      await this.system(orgId, async (trx) => {
        const i = await trx.selectFrom('integrations').select('status').where('id', '=', integrationId).executeTakeFirst();
        if (i?.status === 'CONNECTED') await trx.updateTable('integrationTokens').set({ tokenEnc: enc, updatedAt: new Date() }).where('integrationId', '=', integrationId).execute();
      });
      return n.accessToken;
    } catch (e) {
      if (e instanceof GoogleError && e.code === 'UNAUTHORIZED') {
        await this.system(orgId, (trx) => trx.updateTable('integrations').set({ status: 'ERROR', lastError: 'Google access was revoked or expired. Reconnect.', updatedAt: new Date() }).where('id', '=', integrationId).where('status', '=', 'CONNECTED').execute());
      }
      return this.rethrow(e);
    }
  }

  private async connected(trx: Tx, id: string, provider: Provider) {
    const i = await trx.selectFrom('integrations').select(['id', 'status', 'provider']).where('id', '=', id).executeTakeFirst();
    if (!i || i.provider !== provider) throw new AppError('NOT_FOUND');
    if (i.status !== 'CONNECTED') throw new AppError('CONFLICT', i.status === 'ERROR' ? 'Google access was revoked. Reconnect Google.' : 'Google is disconnected.');
  }

  async disconnect(a: RequestActor, integrationId: string): Promise<void> {
    await this.dbs.run(this.ctx(a), async (trx) => {
      const i = await trx.selectFrom('integrations').select(['status', 'provider', 'accountLogin']).where('id', '=', integrationId).forUpdate().executeTakeFirst();
      if (!i || (i.provider !== 'GOOGLE_CALENDAR' && i.provider !== 'GOOGLE_MAIL')) throw new AppError('NOT_FOUND');
      if (i.status === 'DISCONNECTED') throw new AppError('CONFLICT', 'Already disconnected.');
      // flip the switch first: from this commit on, no sync runs and no new data is written
      await trx.updateTable('integrations').set({ status: 'DISCONNECTED', disconnectedAt: new Date(), updatedAt: new Date() }).where('id', '=', integrationId).execute();
      await trx.updateTable('calendarSources').set({ active: false }).where('integrationId', '=', integrationId).execute();
      await trx.updateTable('emailSources').set({ active: false }).where('integrationId', '=', integrationId).execute();
      await this.audit.record(trx, this.audit.forActor(a, { action: 'integration.disconnected', targetType: 'integration', targetId: integrationId, metadata: { provider: i.provider, account: i.accountLogin } }));
      await this.outbox.enqueue(trx, 'integration.disconnected.v1', { organizationId: a.orgId, integrationId, actorUserId: a.userId }, { orgId: a.orgId });
    });
    // tell Google to invalidate the grant (best effort), then destroy our copy of the credential
    try {
      const r = await this.system(a.orgId, (trx) => trx.selectFrom('integrationTokens').select('tokenEnc').where('integrationId', '=', integrationId).executeTakeFirst());
      if (r && this.google && this.config.integrationKey) {
        const blob = JSON.parse(decryptSecret(r.tokenEnc, this.config.integrationKey, `token:${integrationId}`)) as TokenBlob;
        await this.google.revoke(blob.refreshToken ?? blob.accessToken);
      }
    } catch {
      /* already revoked or unreachable: our side is closed either way */
    }
    await this.system(a.orgId, (trx) => trx.deleteFrom('integrationTokens').where('integrationId', '=', integrationId).execute());
  }

  // ------------------------------------------------------------------ calendar sources

  async availableCalendars(a: RequestActor, integrationId: string) {
    await this.dbs.run(this.ctx(a), (trx) => this.connected(trx, integrationId, 'GOOGLE_CALENDAR'));
    try {
      return await this.gc().listCalendars(await this.accessToken(a.orgId, integrationId));
    } catch (e) {
      return this.rethrow(e);
    }
  }

  async connectCalendar(a: RequestActor, integrationId: string, input: ConnectCalendarInput) {
    await this.dbs.run(this.ctx(a), async (trx) => {
      await this.connected(trx, integrationId, 'GOOGLE_CALENDAR');
      const ws = await trx.selectFrom('workspaces').select('id').where('id', '=', input.workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!ws) throw new AppError('NOT_FOUND', 'Workspace not found');
    });
    let name: string;
    try {
      const cal = (await this.gc().listCalendars(await this.accessToken(a.orgId, integrationId))).find((c) => c.id === input.calendarId);
      if (!cal) throw new AppError('NOT_FOUND', 'That calendar is not available to the connected Google account.');
      name = cal.name;
    } catch (e) {
      return this.rethrow(e);
    }
    return this.dbs.run(this.ctx(a), async (trx) => {
      await this.connected(trx, integrationId, 'GOOGLE_CALENDAR'); // may have been disconnected while we asked Google
      const dup = await trx.selectFrom('calendarSources').select('id').where('calendarId', '=', input.calendarId).where('active', '=', true).executeTakeFirst();
      if (dup) throw new AppError('CONFLICT', 'This calendar is already connected.');
      await trx.deleteFrom('calendarSources').where('calendarId', '=', input.calendarId).where('active', '=', false)
        .where((eb) => eb.not(eb.exists(eb.selectFrom('calendarEvents').select('id').whereRef('calendarEvents.sourceId', '=', 'calendarSources.id')))).execute();
      if (await trx.selectFrom('calendarSources').select('id').where('calendarId', '=', input.calendarId).executeTakeFirst()) {
        throw new AppError('CONFLICT', 'This calendar was connected before; its history is kept. Reconnecting it is not supported yet.');
      }
      const s = await trx.insertInto('calendarSources').values({ organizationId: a.orgId, integrationId, workspaceId: input.workspaceId, calendarId: input.calendarId, name })
        .returning(['id', 'integrationId', 'workspaceId', 'calendarId', 'name', 'lastSyncedAt', 'lastError']).executeTakeFirstOrThrow();
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: input.workspaceId, action: 'integration.calendar_connected', targetType: 'calendar_source', targetId: s.id, metadata: { calendar: name } }));
      await this.outbox.enqueue(trx, 'integration.google_sync_requested.v1', { organizationId: a.orgId, workspaceId: input.workspaceId, kind: 'CALENDAR', sourceId: s.id, requestedByUserId: a.userId }, { orgId: a.orgId, workspaceId: input.workspaceId });
      return s;
    });
  }

  async disconnectCalendar(a: RequestActor, sourceId: string): Promise<void> {
    await this.dbs.run(this.ctx(a), async (trx) => {
      const s = await trx.updateTable('calendarSources').set({ active: false }).where('id', '=', sourceId).returning(['workspaceId', 'name']).executeTakeFirst();
      if (!s) throw new AppError('NOT_FOUND');
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: s.workspaceId, action: 'integration.calendar_disconnected', targetType: 'calendar_source', targetId: sourceId, metadata: { calendar: s.name } }));
    });
  }

  async syncCalendarNow(a: RequestActor, sourceId: string) {
    await this.dbs.run(this.ctx(a), async (trx) => {
      const r = await trx.selectFrom('calendarSources as s').innerJoin('integrations as i', 'i.id', 's.integrationId').select(['s.workspaceId', 's.active', 'i.status']).where('s.id', '=', sourceId).executeTakeFirst();
      if (!r) throw new AppError('NOT_FOUND');
      if (!r.active || r.status !== 'CONNECTED') throw new AppError('CONFLICT', 'This calendar is not connected.');
      await this.throttle(`google:sync:${sourceId}`); // after validation, so a disconnected source says so instead of "slow down"
      await this.outbox.enqueue(trx, 'integration.google_sync_requested.v1', { organizationId: a.orgId, workspaceId: r.workspaceId, kind: 'CALENDAR', sourceId, requestedByUserId: a.userId }, { orgId: a.orgId, workspaceId: r.workspaceId });
    });
    return { queued: true as const };
  }

  private async throttle(key: string) {
    const hit = await this.limiter.hit(key, 30);
    if (hit.count > 1) throw new AppError('RATE_LIMITED', 'A sync was just requested. Try again in a moment.', { retryAfterSec: hit.retryAfterSec });
  }

  // ------------------------------------------------------------------ mailbox source

  async connectMailbox(a: RequestActor, integrationId: string, input: ConnectMailboxInput) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      await this.connected(trx, integrationId, 'GOOGLE_MAIL');
      const ws = await trx.selectFrom('workspaces').select('id').where('id', '=', input.workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!ws) throw new AppError('NOT_FOUND', 'Workspace not found');
      if (input.projectId) {
        const p = await trx.selectFrom('projects').select('id').where('id', '=', input.projectId).where('workspaceId', '=', input.workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
        if (!p) throw new AppError('VALIDATION_FAILED', 'Project not found in this workspace');
      }
      const existing = await trx.selectFrom('emailSources').select(['id', 'active']).where('integrationId', '=', integrationId).forUpdate().executeTakeFirst();
      if (existing?.active) throw new AppError('CONFLICT', 'A mailbox is already connected. Disconnect it first.');
      const cols = ['id', 'integrationId', 'workspaceId', 'projectId', 'label', 'lastSyncedAt', 'lastError'] as const;
      const s = existing
        ? await trx.updateTable('emailSources').set({ workspaceId: input.workspaceId, projectId: input.projectId ?? null, label: input.label, active: true, syncedUntil: null, lastError: null }).where('id', '=', existing.id).returning(cols).executeTakeFirstOrThrow()
        : await trx.insertInto('emailSources').values({ organizationId: a.orgId, integrationId, workspaceId: input.workspaceId, projectId: input.projectId ?? null, label: input.label }).returning(cols).executeTakeFirstOrThrow();
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: input.workspaceId, action: 'integration.mailbox_connected', targetType: 'email_source', targetId: s.id, metadata: { label: input.label } }));
      await this.outbox.enqueue(trx, 'integration.google_sync_requested.v1', { organizationId: a.orgId, workspaceId: input.workspaceId, kind: 'MAIL', sourceId: s.id, requestedByUserId: a.userId }, { orgId: a.orgId, workspaceId: input.workspaceId });
      return s;
    });
  }

  async disconnectMailbox(a: RequestActor, sourceId: string): Promise<void> {
    await this.dbs.run(this.ctx(a), async (trx) => {
      const s = await trx.updateTable('emailSources').set({ active: false }).where('id', '=', sourceId).returning(['workspaceId', 'label']).executeTakeFirst();
      if (!s) throw new AppError('NOT_FOUND');
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: s.workspaceId, action: 'integration.mailbox_disconnected', targetType: 'email_source', targetId: sourceId, metadata: { label: s.label } }));
    });
  }

  async syncMailboxNow(a: RequestActor, sourceId: string) {
    await this.dbs.run(this.ctx(a), async (trx) => {
      const r = await trx.selectFrom('emailSources as s').innerJoin('integrations as i', 'i.id', 's.integrationId').select(['s.workspaceId', 's.active', 'i.status']).where('s.id', '=', sourceId).executeTakeFirst();
      if (!r) throw new AppError('NOT_FOUND');
      if (!r.active || r.status !== 'CONNECTED') throw new AppError('CONFLICT', 'This mailbox is not connected.');
      await this.throttle(`google:sync:${sourceId}`);
      await this.outbox.enqueue(trx, 'integration.google_sync_requested.v1', { organizationId: a.orgId, workspaceId: r.workspaceId, kind: 'MAIL', sourceId, requestedByUserId: a.userId }, { orgId: a.orgId, workspaceId: r.workspaceId });
    });
    return { queued: true as const };
  }

  // ------------------------------------------------------------------ events + meeting linking (user context, workspace-scoped by RLS)

  async events(a: RequestActor, q: { workspaceId?: string; from?: string; to?: string; limit: number }) {
    const from = q.from ? new Date(q.from) : new Date();
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 14 * 864e5);
    if (!(to > from) || to.getTime() - from.getTime() > 120 * 864e5) throw new AppError('VALIDATION_FAILED', 'Choose a range of at most 120 days.');
    return this.dbs.run(this.ctx(a), async (trx) => {
      let qb = trx.selectFrom('calendarEvents as e').leftJoin('meetingCalendarLinks as l', 'l.eventId', 'e.id')
        .select(['e.id', 'e.workspaceId', 'e.title', 'e.startsAt', 'e.endsAt', 'e.allDay', 'e.status', 'e.htmlLink', 'e.attendeeCount', 'l.meetingId'])
        .where('e.endsAt', '>', from).where('e.startsAt', '<', to);
      if (q.workspaceId) qb = qb.where('e.workspaceId', '=', q.workspaceId);
      const rows = await qb.orderBy('e.startsAt').orderBy('e.id').limit(q.limit).execute();
      // scheduling info: timed, confirmed events that overlap another one in the same workspace
      const timed = rows.filter((r) => !r.allDay && r.status === 'confirmed');
      const conflicts = new Set<string>();
      for (const x of timed) for (const y of timed) if (x.id < y.id && x.workspaceId === y.workspaceId && x.startsAt < y.endsAt && y.startsAt < x.endsAt) { conflicts.add(x.id); conflicts.add(y.id); }
      return rows.map((r) => ({ ...r, conflict: conflicts.has(r.id) }));
    });
  }

  async meetingEvent(a: RequestActor, meetingId: string) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const m = await trx.selectFrom('meetings').select('id').where('id', '=', meetingId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!m) throw new AppError('NOT_FOUND');
      return (await trx.selectFrom('meetingCalendarLinks as l').innerJoin('calendarEvents as e', 'e.id', 'l.eventId')
        .select(['e.id', 'e.title', 'e.startsAt', 'e.endsAt', 'e.htmlLink']).where('l.meetingId', '=', meetingId).executeTakeFirst()) ?? null;
    });
  }

  async linkMeeting(a: RequestActor, meetingId: string, eventId: string) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const m = await trx.selectFrom('meetings').select(['workspaceId', 'heldAt']).where('id', '=', meetingId).where('deletedAt', 'is', null).forUpdate().executeTakeFirst();
      if (!m) throw new AppError('NOT_FOUND');
      const e = await trx.selectFrom('calendarEvents').select(['workspaceId', 'startsAt']).where('id', '=', eventId).executeTakeFirst();
      if (!e || e.workspaceId !== m.workspaceId) throw new AppError('NOT_FOUND', 'Event not found in this workspace');
      const r = await trx.insertInto('meetingCalendarLinks').values({ organizationId: a.orgId, workspaceId: m.workspaceId, meetingId, eventId, createdBy: a.userId })
        .onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
      if (!r) throw new AppError('CONFLICT', 'This meeting or this event is already linked.');
      if (!m.heldAt) await trx.updateTable('meetings').set({ heldAt: e.startsAt, updatedAt: new Date() }).where('id', '=', meetingId).execute(); // when it happened comes from the calendar
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: m.workspaceId, action: 'meeting.calendar_linked', targetType: 'meeting', targetId: meetingId, metadata: { eventId } }));
      return { id: r.id };
    });
  }

  async unlinkMeeting(a: RequestActor, meetingId: string): Promise<void> {
    await this.dbs.run(this.ctx(a), async (trx) => {
      const r = await trx.deleteFrom('meetingCalendarLinks').where('meetingId', '=', meetingId).returning('workspaceId').executeTakeFirst();
      if (!r) throw new AppError('NOT_FOUND');
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: r.workspaceId, action: 'meeting.calendar_unlinked', targetType: 'meeting', targetId: meetingId }));
    });
  }
}
