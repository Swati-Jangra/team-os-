import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Tx } from '@teamos/database';
import { hasPermission } from '@teamos/permissions';
import {
  GitHubError, decryptSecret, encryptSecret, generateWebhookSecret, verifyGitHubSignature, type GitHubClient,
} from '@teamos/integrations';
import { AppError, buildPageMeta, normalizePage, toSkipTake, type PageMeta } from '@teamos/shared';
import type { ConnectRepoInput } from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import type { AppConfig } from '../../common/app-config';
import type { RateLimiter } from '../../common/rate-limit/rate-limiter';
import { APP_CONFIG, GITHUB_CLIENT, RATE_LIMITER } from '../../common/tokens';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';

/** Minimum scopes GitHub OAuth Apps offer for this: read repositories (incl. private) and manage their webhooks. */
export const GITHUB_SCOPES = ['repo', 'admin:repo_hook'];
const STATE_TTL_MS = 10 * 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface IntegrationDto {
  id: string;
  provider: 'GITHUB' | 'GOOGLE_CALENDAR' | 'GOOGLE_MAIL';
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  accountLogin: string;
  scopes: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}
export interface RepoDto {
  id: string;
  integrationId: string;
  workspaceId: string;
  projectId: string | null;
  fullName: string;
  active: boolean;
  webhookActive: boolean;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient | null,
  ) {}

  private get key(): Buffer {
    if (!this.config.integrationKey || !this.github) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'GitHub is not configured on this server.');
    return this.config.integrationKey;
  }
  private gh(): GitHubClient {
    this.key; // eslint-disable-line @typescript-eslint/no-unused-expressions
    return this.github!;
  }
  private ctx(a: RequestActor) {
    return { userId: a.userId, orgId: a.orgId };
  }
  /** Credentials are only reachable in the background ("system") context: no user id, scoped to ONE organization. */
  private system<T>(orgId: string, fn: (trx: Tx) => Promise<T>) {
    return this.dbs.run({ orgId }, fn);
  }
  private get redirectUri() {
    return `${this.config.appUrl}/api/v1/integrations/github/callback`;
  }
  private rethrow(e: unknown): never {
    if (e instanceof AppError) throw e;
    if (e instanceof GitHubError) {
      if (e.code === 'UNAUTHORIZED') throw new AppError('CONFLICT', 'GitHub access was revoked. Reconnect GitHub.');
      if (e.code === 'NOT_FOUND') throw new AppError('NOT_FOUND', 'Repository not found, or the connected GitHub account cannot access it.');
      if (e.code === 'RATE_LIMITED') throw new AppError('RATE_LIMITED', 'GitHub rate limit reached. Try again later.');
      throw new AppError('UPSTREAM_ERROR', 'GitHub returned an error. Please try again.');
    }
    throw e;
  }

  // ------------------------------------------------------------------ reading

  async overview(a: RequestActor): Promise<{ configured: boolean; appUrl: string; integration: IntegrationDto | null; repos: RepoDto[] }> {
    const configured = !!this.config.integrationKey && !!this.github;
    return this.dbs.run(this.ctx(a), async (trx) => {
      const integration = await trx.selectFrom('integrations')
        .select(['id', 'provider', 'status', 'accountLogin', 'scopes', 'lastSyncedAt', 'lastError', 'createdAt'])
        .where('status', '<>', 'DISCONNECTED').where('provider', '=', 'GITHUB').executeTakeFirst();
      const repos = integration
        ? await trx.selectFrom('integrationRepos')
            .select(['id', 'integrationId', 'workspaceId', 'projectId', 'fullName', 'active', 'webhookId', 'lastSyncedAt', 'lastError', 'createdAt'])
            .where('integrationId', '=', integration.id).where('active', '=', true).orderBy('fullName').execute()
        : [];
      return { configured, appUrl: this.config.appUrl, integration: integration ?? null, repos: repos.map(({ webhookId, ...r }) => ({ ...r, webhookActive: webhookId !== null })) };
    });
  }

  // ------------------------------------------------------------------ OAuth

  async startGitHub(a: RequestActor): Promise<{ url: string }> {
    const gh = this.gh();
    const state = randomBytes(32).toString('base64url');
    await this.dbs.db.insertInto('oauthStates').values({
      stateHash: sha256(state), organizationId: a.orgId, userId: a.userId, provider: 'GITHUB', expiresAt: new Date(Date.now() + STATE_TTL_MS),
    }).execute();
    return { url: gh.authorizeUrl(state, this.redirectUri, GITHUB_SCOPES) };
  }

  /**
   * Browser callback. The organization comes from the server-side state row (never from the URL), the state is single-use
   * and bound to the signed-in user, and that user must still be allowed to manage integrations.
   */
  async finishGitHub(user: UserActor, q: { code?: string; state: string; error?: string }): Promise<{ orgId: string | null; ok: boolean }> {
    const gh = this.gh();
    const row = await this.dbs.db.deleteFrom('oauthStates').where('stateHash', '=', sha256(q.state)).where('userId', '=', user.userId).where('provider', '=', 'GITHUB')
      .returning(['organizationId', 'expiresAt']).executeTakeFirst();
    if (!row || row.expiresAt.getTime() < Date.now()) throw new AppError('TOKEN_INVALID', 'This connection attempt expired. Start again.');
    const orgId = row.organizationId;
    if (q.error || !q.code) return { orgId, ok: false };

    const role = await this.dbs.run({ userId: user.userId, orgId }, (trx) =>
      trx.selectFrom('organizationMembers').select('role').where('userId', '=', user.userId).where('organizationId', '=', orgId).where('deletedAt', 'is', null).executeTakeFirst());
    if (!role || !hasPermission(role.role, 'integration:manage')) throw new AppError('FORBIDDEN');

    let accessToken: string, scope: string, viewer: { id: number; login: string };
    try {
      ({ accessToken, scope } = await gh.exchangeCode(q.code, this.redirectUri));
      viewer = await gh.getViewer(accessToken);
    } catch (e) {
      return this.rethrow(e);
    }
    const actor = { userId: user.userId, orgId, role: role.role, requestId: user.requestId, ip: user.ip } as RequestActor;
    const integrationId = await this.dbs.run(this.ctx(actor), async (trx) => {
      const existing = await trx.selectFrom('integrations').select('id').where('provider', '=', 'GITHUB').where('status', '<>', 'DISCONNECTED').forUpdate().executeTakeFirst();
      let id: string;
      if (existing) {
        id = existing.id;
        await trx.updateTable('integrations').set({ status: 'CONNECTED', accountLogin: viewer.login, accountId: String(viewer.id), scopes: scope, lastError: null, updatedAt: new Date() }).where('id', '=', id).execute();
      } else {
        id = (await trx.insertInto('integrations').values({ organizationId: orgId, provider: 'GITHUB', accountLogin: viewer.login, accountId: String(viewer.id), scopes: scope, connectedBy: user.userId }).returning('id').executeTakeFirstOrThrow()).id;
      }
      await this.audit.record(trx, this.audit.forActor(actor, { action: 'integration.connected', targetType: 'integration', targetId: id, metadata: { provider: 'GITHUB', account: viewer.login, scopes: scope } }));
      await this.outbox.enqueue(trx, 'integration.connected.v1', { organizationId: orgId, integrationId: id, actorUserId: user.userId }, { orgId });
      return id;
    });
    // credentials go through the background context only, encrypted and bound to this integration row
    const enc = encryptSecret(accessToken, this.key, `token:${integrationId}`);
    await this.system(orgId, async (trx) => {
      await trx.insertInto('integrationTokens').values({ integrationId, organizationId: orgId, tokenEnc: enc })
        .onConflict((oc) => oc.column('integrationId').doUpdateSet({ tokenEnc: enc, updatedAt: new Date() })).execute();
    });
    return { orgId, ok: true };
  }

  private async tokenFor(orgId: string, integrationId: string): Promise<string> {
    const r = await this.system(orgId, (trx) => trx.selectFrom('integrationTokens').select('tokenEnc').where('integrationId', '=', integrationId).executeTakeFirst());
    if (!r) throw new AppError('CONFLICT', 'GitHub is not connected.');
    return decryptSecret(r.tokenEnc, this.key, `token:${integrationId}`);
  }

  private async connectedIntegration(trx: Tx, id: string) {
    const i = await trx.selectFrom('integrations').select(['id', 'status']).where('id', '=', id).executeTakeFirst();
    if (!i) throw new AppError('NOT_FOUND');
    if (i.status !== 'CONNECTED') throw new AppError('CONFLICT', i.status === 'ERROR' ? 'GitHub access was revoked. Reconnect GitHub.' : 'GitHub is disconnected.');
    return i;
  }

  // ------------------------------------------------------------------ repositories

  async availableRepos(a: RequestActor, integrationId: string): Promise<Array<{ fullName: string; private: boolean }>> {
    await this.dbs.run(this.ctx(a), (trx) => this.connectedIntegration(trx, integrationId));
    try {
      const token = await this.tokenFor(a.orgId, integrationId);
      return (await this.gh().listRepos(token)).map((r) => ({ fullName: r.fullName, private: r.private }));
    } catch (e) {
      return this.rethrow(e);
    }
  }

  async connectRepo(a: RequestActor, integrationId: string, input: ConnectRepoInput): Promise<RepoDto> {
    const gh = this.gh();
    await this.dbs.run(this.ctx(a), async (trx) => {
      await this.connectedIntegration(trx, integrationId);
      const ws = await trx.selectFrom('workspaces').select('id').where('id', '=', input.workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!ws) throw new AppError('NOT_FOUND', 'Workspace not found');
      if (input.projectId) {
        const p = await trx.selectFrom('projects').select('id').where('id', '=', input.projectId).where('workspaceId', '=', input.workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
        if (!p) throw new AppError('VALIDATION_FAILED', 'Project not found in this workspace');
      }
      const dup = await trx.selectFrom('integrationRepos').select('id').where('fullName', '=', input.fullName).where('active', '=', true).executeTakeFirst();
      if (dup) throw new AppError('CONFLICT', 'This repository is already connected.');
    });

    const repoId = randomUUID();
    const secret = generateWebhookSecret();
    let hookId: number;
    let externalId: string;
    let token: string;
    try {
      token = await this.tokenFor(a.orgId, integrationId);
      const info = await gh.getRepo(token, input.fullName); // proves the connected account can see it, and gives the canonical name
      externalId = String(info.id);
      hookId = (await gh.createWebhook(token, info.fullName, `${this.config.apiUrl}/api/v1/webhooks/github/${repoId}`, secret)).id;
    } catch (e) {
      return this.rethrow(e);
    }
    try {
      return await this.dbs.run(this.ctx(a), async (trx) => {
        // a deactivated row for the same repo (earlier connection) is reused so (org, full_name) stays unique
        await trx.deleteFrom('integrationRepos').where('fullName', '=', input.fullName).where('active', '=', false)
          .where((eb) => eb.not(eb.exists(eb.selectFrom('externalItems').select('id').whereRef('externalItems.repoId', '=', 'integrationRepos.id')))).execute();
        const prior = await trx.selectFrom('integrationRepos').select('id').where('fullName', '=', input.fullName).executeTakeFirst();
        if (prior) throw new AppError('CONFLICT', 'This repository was connected before; its history is kept. Reconnecting it is not supported yet.');
        await trx.insertInto('integrationRepos').values({
          id: repoId, organizationId: a.orgId, integrationId, workspaceId: input.workspaceId, projectId: input.projectId ?? null, fullName: input.fullName,
          externalId, webhookId: hookId, webhookSecretEnc: encryptSecret(secret, this.key, `webhook:${repoId}`),
        }).execute();
        await this.audit.record(trx, this.audit.forActor(a, { workspaceId: input.workspaceId, action: 'integration.repo_connected', targetType: 'integration_repo', targetId: repoId, metadata: { repo: input.fullName } }));
        await this.outbox.enqueue(trx, 'integration.sync_requested.v1', { organizationId: a.orgId, workspaceId: input.workspaceId, repoId, requestedByUserId: a.userId }, { orgId: a.orgId, workspaceId: input.workspaceId });
        const r = await trx.selectFrom('integrationRepos').select(['id', 'integrationId', 'workspaceId', 'projectId', 'fullName', 'active', 'lastSyncedAt', 'lastError', 'createdAt']).where('id', '=', repoId).executeTakeFirstOrThrow();
        return { ...r, webhookActive: true };
      });
    } catch (e) {
      await gh.deleteWebhook(token, input.fullName, hookId).catch(() => undefined); // do not leave an orphaned webhook on GitHub
      throw e;
    }
  }

  async disconnectRepo(a: RequestActor, repoId: string): Promise<void> {
    const repo = await this.dbs.run(this.ctx(a), async (trx) => {
      const r = await trx.selectFrom('integrationRepos').select(['id', 'integrationId', 'fullName', 'workspaceId', 'webhookId', 'active']).where('id', '=', repoId).executeTakeFirst();
      if (!r) throw new AppError('NOT_FOUND');
      await trx.updateTable('integrationRepos').set({ active: false }).where('id', '=', repoId).execute(); // stops syncing/webhooks immediately
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: r.workspaceId, action: 'integration.repo_disconnected', targetType: 'integration_repo', targetId: repoId, metadata: { repo: r.fullName } }));
      return r;
    });
    await this.removeHook(a.orgId, repo.integrationId, repo.fullName, repo.webhookId);
  }

  private async removeHook(orgId: string, integrationId: string, fullName: string, hookId: string | null): Promise<void> {
    if (!hookId || !this.github) return;
    try {
      await this.github.deleteWebhook(await this.tokenFor(orgId, integrationId), fullName, Number(hookId)); // best effort: it is already inert on our side
    } catch {
      /* the hook may be gone, or the token revoked; deliveries are rejected here either way */
    }
  }

  async disconnect(a: RequestActor, integrationId: string): Promise<void> {
    const repos = await this.dbs.run(this.ctx(a), async (trx) => {
      const i = await trx.selectFrom('integrations').select(['id', 'status', 'accountLogin']).where('id', '=', integrationId).forUpdate().executeTakeFirst();
      if (!i) throw new AppError('NOT_FOUND');
      if (i.status === 'DISCONNECTED') throw new AppError('CONFLICT', 'Already disconnected.');
      // 1. flip the switch first: from this commit on, sync and webhook processing are refused
      await trx.updateTable('integrations').set({ status: 'DISCONNECTED', disconnectedAt: new Date(), updatedAt: new Date() }).where('id', '=', integrationId).execute();
      const rs = await trx.updateTable('integrationRepos').set({ active: false }).where('integrationId', '=', integrationId).where('active', '=', true).returning(['fullName', 'webhookId']).execute();
      await this.audit.record(trx, this.audit.forActor(a, { action: 'integration.disconnected', targetType: 'integration', targetId: integrationId, metadata: { account: i.accountLogin } }));
      await this.outbox.enqueue(trx, 'integration.disconnected.v1', { organizationId: a.orgId, integrationId, actorUserId: a.userId }, { orgId: a.orgId });
      return rs;
    });
    // 2. remove webhooks while we still hold the token, then 3. destroy the credential
    for (const r of repos) await this.removeHook(a.orgId, integrationId, r.fullName, r.webhookId);
    await this.system(a.orgId, (trx) => trx.deleteFrom('integrationTokens').where('integrationId', '=', integrationId).execute());
  }

  async syncNow(a: RequestActor, repoId: string): Promise<{ queued: true }> {
    const hit = await this.limiter.hit(`integration:sync:${repoId}`, 30);
    if (hit.count > 1) throw new AppError('RATE_LIMITED', 'A sync was just requested. Try again in a moment.', { retryAfterSec: hit.retryAfterSec });
    await this.dbs.run(this.ctx(a), async (trx) => {
      const r = await trx.selectFrom('integrationRepos as r').innerJoin('integrations as i', 'i.id', 'r.integrationId').select(['r.workspaceId', 'r.active', 'i.status']).where('r.id', '=', repoId).executeTakeFirst();
      if (!r) throw new AppError('NOT_FOUND');
      if (!r.active || r.status !== 'CONNECTED') throw new AppError('CONFLICT', 'This repository is not connected.');
      await this.outbox.enqueue(trx, 'integration.sync_requested.v1', { organizationId: a.orgId, workspaceId: r.workspaceId, repoId, requestedByUserId: a.userId }, { orgId: a.orgId, workspaceId: r.workspaceId });
    });
    return { queued: true };
  }

  // ------------------------------------------------------------------ webhooks (public, unauthenticated: the signature is the credential)

  async receiveGitHub(repoId: string, rawBody: Buffer | undefined, headers: { signature?: string; event?: string; delivery?: string }, body: unknown): Promise<{ accepted: boolean; duplicate?: boolean }> {
    const miss = new AppError('NOT_FOUND'); // unknown and disconnected repositories look identical
    if (!this.config.integrationKey || !rawBody) throw miss;
    const look = await this.lookup(repoId);
    if (!look || !look.repoActive || look.integrationStatus !== 'CONNECTED') throw miss;
    let secret: string;
    try {
      secret = decryptSecret(look.webhookSecretEnc, this.config.integrationKey, `webhook:${repoId}`);
    } catch {
      throw miss;
    }
    if (!verifyGitHubSignature(secret, rawBody, headers.signature)) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
    if (!headers.event || !headers.delivery || typeof body !== 'object' || body === null) throw new AppError('VALIDATION_FAILED', 'Missing delivery headers or body');

    return this.system(look.organizationId, async (trx) => {
      const row = await trx.insertInto('webhookEvents').values({
        organizationId: look.organizationId, repoId, deliveryId: headers.delivery!.slice(0, 100), eventType: headers.event!.slice(0, 50), payload: JSON.stringify(body),
      }).onConflict((oc) => oc.columns(['repoId', 'deliveryId']).doNothing()).returning('id').executeTakeFirst();
      if (!row) return { accepted: true, duplicate: true }; // GitHub redelivered: already stored, nothing more to do
      await this.outbox.enqueue(trx, 'integration.webhook_received.v1', { organizationId: look.organizationId, workspaceId: look.workspaceId, repoId, webhookEventId: row.id }, { orgId: look.organizationId, workspaceId: look.workspaceId });
      return { accepted: true };
    });
  }

  private async lookup(repoId: string) {
    const r = await this.dbs.run({}, async (trx) =>
      (await sql<{ organizationId: string; workspaceId: string; integrationId: string; webhookSecretEnc: string; repoActive: boolean; integrationStatus: string }>`SELECT * FROM webhook_repo_lookup(${repoId}::uuid)`.execute(trx)).rows[0]);
    return r ?? null;
  }

  // ------------------------------------------------------------------ synced items + task links

  async listItems(a: RequestActor, q: { page?: number; pageSize?: number; workspaceId?: string; kind?: 'PULL_REQUEST' | 'ISSUE' | 'COMMIT'; q?: string }) {
    const params = normalizePage(q);
    return this.dbs.run(this.ctx(a), async (trx) => {
      let base = trx.selectFrom('externalItems');
      if (q.workspaceId) base = base.where('workspaceId', '=', q.workspaceId);
      if (q.kind) base = base.where('kind', '=', q.kind);
      if (q.q) base = base.where('title', 'ilike', `%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
      const total = Number((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
      const { skip, take } = toSkipTake(params);
      const items = await base.select(['id', 'workspaceId', 'kind', 'externalId', 'title', 'state', 'url', 'authorLogin', 'updatedExtAt']).orderBy('updatedExtAt', 'desc').orderBy('id').limit(take).offset(skip).execute();
      const links = items.length
        ? await trx.selectFrom('taskLinks as l').innerJoin('tasks as t', 't.id', 'l.taskId').innerJoin('projects as p', 'p.id', 't.projectId')
            .select(['l.itemId', 't.id as taskId', 'p.key', 't.number']).where('l.itemId', 'in', items.map((i) => i.id)).execute()
        : [];
      return {
        items: items.map((i) => ({ ...i, tasks: links.filter((l) => l.itemId === i.id).map((l) => ({ id: l.taskId, identifier: `${l.key}-${l.number}` })) })),
        meta: buildPageMeta(params, total) as PageMeta,
      };
    });
  }

  async taskLinks(a: RequestActor, taskId: string) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      await this.visibleTask(trx, taskId);
      return trx.selectFrom('taskLinks as l').innerJoin('externalItems as i', 'i.id', 'l.itemId')
        .select(['l.id as linkId', 'l.source', 'i.id as itemId', 'i.kind', 'i.externalId', 'i.title', 'i.state', 'i.url', 'i.authorLogin'])
        .where('l.taskId', '=', taskId).orderBy('i.kind').orderBy('i.updatedExtAt', 'desc').execute();
    });
  }

  private async visibleTask(trx: Tx, taskId: string) {
    const t = await trx.selectFrom('tasks').select(['id', 'workspaceId']).where('id', '=', taskId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!t) throw new AppError('NOT_FOUND');
    return t;
  }

  async linkTask(a: RequestActor, taskId: string, itemId: string) {
    return this.dbs.run(this.ctx(a), async (trx) => {
      const t = await this.visibleTask(trx, taskId);
      const item = await trx.selectFrom('externalItems').select(['id', 'workspaceId']).where('id', '=', itemId).executeTakeFirst();
      if (!item || item.workspaceId !== t.workspaceId) throw new AppError('NOT_FOUND', 'Item not found in this workspace');
      const row = await trx.insertInto('taskLinks').values({ organizationId: a.orgId, workspaceId: t.workspaceId, taskId, itemId, source: 'MANUAL', createdBy: a.userId })
        .onConflict((oc) => oc.columns(['taskId', 'itemId']).doNothing()).returning('id').executeTakeFirst();
      if (!row) throw new AppError('CONFLICT', 'Already linked.');
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: t.workspaceId, action: 'task_link.created', targetType: 'task', targetId: taskId, metadata: { itemId } }));
      return { id: row.id };
    });
  }

  async unlinkTask(a: RequestActor, taskId: string, linkId: string): Promise<void> {
    await this.dbs.run(this.ctx(a), async (trx) => {
      const t = await this.visibleTask(trx, taskId);
      const r = await trx.deleteFrom('taskLinks').where('id', '=', linkId).where('taskId', '=', taskId).executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) throw new AppError('NOT_FOUND');
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId: t.workspaceId, action: 'task_link.deleted', targetType: 'task', targetId: taskId, metadata: { linkId } }));
    });
  }
}
