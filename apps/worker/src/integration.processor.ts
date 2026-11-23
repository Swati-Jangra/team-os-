import type { Job } from 'bullmq';
import { sql, withContext, type Database, type Tx } from '@teamos/database';
import { parseEventPayload, type EventType } from '@teamos/event-contracts';
import {
  GitHubError, decryptSecret, extractTaskKeys, normalizeCommit, normalizeIssue, normalizePull, type ExternalItem, type GitHubClient,
} from '@teamos/integrations';
import { syncCalendar, syncMailbox, type GoogleDeps } from './google.processor';
import type { JobData } from './queues';

export interface IntegrationDeps {
  db: Database;
  github: GitHubClient;
  key: Buffer;
  log?: (m: string) => void;
  now?: () => Date;
}

export interface RepoState {
  id: string;
  organizationId: string;
  workspaceId: string;
  projectId: string | null;
  fullName: string;
  integrationId: string;
  active: boolean;
  integrationStatus: string;
  syncedUntil: Date | null;
  tokenEnc: string | null;
}
export interface SyncResult {
  status: 'synced' | 'skipped';
  reason?: string;
  changed?: number;
  linked?: number;
}

const MAX_EVENTS_PER_RUN = 50;
const OVERLAP_MS = 5 * 60_000; // re-read a little before the cursor so clock skew / late updates are never missed (upserts are idempotent)

async function loadRepo(deps: IntegrationDeps, orgId: string, repoId: string): Promise<RepoState | null> {
  return withContext(deps.db, { orgId }, async (trx) => {
    const r = await trx
      .selectFrom('integrationRepos as r')
      .innerJoin('integrations as i', 'i.id', 'r.integrationId')
      .leftJoin('integrationTokens as t', 't.integrationId', 'r.integrationId')
      .select(['r.id', 'r.organizationId', 'r.workspaceId', 'r.projectId', 'r.fullName', 'r.integrationId', 'r.active', 'i.status as integrationStatus', 'r.syncedUntil', 't.tokenEnc'])
      .where('r.id', '=', repoId)
      .executeTakeFirst();
    return r ?? null;
  });
}

/** Insert new items, update changed ones, ignore stale (older than what we hold) and unchanged ones. Returns what actually changed. */
async function upsertItems(trx: Tx, repo: RepoState, items: ExternalItem[], now: Date) {
  const changed: Array<{ id: string; item: ExternalItem }> = [];
  const byKey = new Map(items.map((i) => [`${i.kind}:${i.externalId}`, i]));
  const unique = [...byKey.values()];
  for (let off = 0; off < unique.length; off += 400) {
    const batch = unique.slice(off, off + 400);
    const existing = await trx.selectFrom('externalItems').select(['id', 'kind', 'externalId', 'title', 'state', 'updatedExtAt'])
      .where('repoId', '=', repo.id).where('externalId', 'in', batch.map((b) => b.externalId)).execute();
    const have = new Map(existing.map((e) => [`${e.kind}:${e.externalId}`, e]));
    for (const it of batch) {
      const cur = have.get(`${it.kind}:${it.externalId}`);
      const updated = it.updatedAt ? new Date(it.updatedAt) : null;
      const values = {
        title: it.title, state: it.state, url: it.url, authorLogin: it.authorLogin, headRef: it.headRef,
        createdExtAt: it.createdAt ? new Date(it.createdAt) : null, updatedExtAt: updated, mergedAt: it.mergedAt ? new Date(it.mergedAt) : null, syncedAt: now,
      };
      if (!cur) {
        const row = await trx.insertInto('externalItems').values({ organizationId: repo.organizationId, workspaceId: repo.workspaceId, repoId: repo.id, kind: it.kind, externalId: it.externalId, ...values })
          .onConflict((oc) => oc.columns(['repoId', 'kind', 'externalId']).doNothing()).returning('id').executeTakeFirst();
        if (row) changed.push({ id: row.id, item: it });
        continue;
      }
      if (it.kind === 'COMMIT') continue; // commits are immutable
      if (updated && cur.updatedExtAt && updated < cur.updatedExtAt) continue; // out-of-order delivery: never go back in time
      if (cur.title === it.title && cur.state === it.state && cur.updatedExtAt?.getTime() === updated?.getTime()) continue;
      await trx.updateTable('externalItems').set(values).where('id', '=', cur.id).execute();
      changed.push({ id: cur.id, item: it });
    }
  }
  return changed;
}

/** Links PRs/issues/commits to tasks whose identifier (e.g. APO-12) appears in the title or branch. Only tasks in the repository's workspace. */
async function autoLink(trx: Tx, repo: RepoState, rows: Array<{ id: string; item: ExternalItem }>): Promise<number> {
  let linked = 0;
  for (const { id, item } of rows) {
    for (const k of extractTaskKeys(item.title, item.headRef).slice(0, 5)) {
      // tasks are not readable in a background context; resolve through a function scoped to this org + workspace
      const found = await sql<{ id: string | null }>`SELECT job_find_task(${repo.organizationId}::uuid, ${repo.workspaceId}::uuid, ${k.key}, ${k.number}::int, ${repo.projectId}::uuid) AS id`.execute(trx);
      const task = found.rows[0]?.id ? { id: found.rows[0].id } : undefined;
      if (!task) continue;
      const res = await trx.insertInto('taskLinks').values({ organizationId: repo.organizationId, workspaceId: repo.workspaceId, taskId: task.id, itemId: id, source: 'AUTO' })
        .onConflict((oc) => oc.columns(['taskId', 'itemId']).doNothing()).executeTakeFirst();
      if (Number(res.numInsertedOrUpdatedRows ?? 0) > 0) linked++;
    }
  }
  return linked;
}

const emitPrEvents = async (trx: Tx, repo: RepoState, rows: Array<{ id: string; item: ExternalItem }>) => {
  for (const { id, item } of rows.filter((r) => r.item.kind === 'PULL_REQUEST').slice(0, MAX_EVENTS_PER_RUN)) {
    await trx.insertInto('outboxEvents').values({
      type: 'github.pull_request.updated.v1', version: 1, organizationId: repo.organizationId, workspaceId: repo.workspaceId, lastError: null,
      payload: JSON.stringify({ organizationId: repo.organizationId, workspaceId: repo.workspaceId, repoId: repo.id, itemId: id, number: item.externalId, state: item.state }),
    }).execute();
  }
};

/** Lock the integration + repo rows and confirm they are still connected. A disconnect that happens mid-sync wins. */
async function stillConnected(trx: Tx, repoId: string): Promise<boolean> {
  const r = await trx.selectFrom('integrationRepos as r').innerJoin('integrations as i', 'i.id', 'r.integrationId')
    .select(['r.active', 'i.status']).where('r.id', '=', repoId).forUpdate('i').executeTakeFirst();
  return !!r && r.active && r.status === 'CONNECTED';
}

export async function syncRepo(deps: IntegrationDeps, orgId: string, repoId: string): Promise<SyncResult> {
  const now = (deps.now ?? (() => new Date()))();
  const repo = await loadRepo(deps, orgId, repoId);
  if (!repo || !repo.active || repo.integrationStatus !== 'CONNECTED' || !repo.tokenEnc) return { status: 'skipped', reason: 'not connected' };
  const token = decryptSecret(repo.tokenEnc, deps.key, `token:${repo.integrationId}`);
  const since = repo.syncedUntil ? new Date(repo.syncedUntil.getTime() - OVERLAP_MS).toISOString() : null;

  let items: ExternalItem[];
  try {
    const [pulls, issues, commits] = [
      await deps.github.listPulls(token, repo.fullName, since),
      await deps.github.listIssues(token, repo.fullName, since),
      await deps.github.listCommits(token, repo.fullName, since),
    ];
    items = [...pulls, ...issues, ...commits];
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    return handleGitHubError(deps, repo, e);
  }

  return withContext(deps.db, { orgId }, async (trx) => {
    if (!(await stillConnected(trx, repo.id))) return { status: 'skipped', reason: 'disconnected during sync' } as SyncResult;
    const changed = await upsertItems(trx, repo, items, now);
    const linked = await autoLink(trx, repo, changed);
    await emitPrEvents(trx, repo, changed);
    await trx.updateTable('integrationRepos').set({ syncedUntil: now, lastSyncedAt: now, lastError: null }).where('id', '=', repo.id).execute();
    await trx.updateTable('integrations').set({ lastSyncedAt: now, lastError: null, updatedAt: now }).where('id', '=', repo.integrationId).execute();
    return { status: 'synced', changed: changed.length, linked } as SyncResult;
  });
}

async function handleGitHubError(deps: IntegrationDeps, repo: RepoState, e: GitHubError): Promise<SyncResult> {
  await withContext(deps.db, { orgId: repo.organizationId }, async (trx) => {
    if (e.code === 'UNAUTHORIZED') {
      // the token was revoked/expired: stop syncing until a person reconnects (retrying would just hammer GitHub)
      await trx.updateTable('integrations').set({ status: 'ERROR', lastError: 'GitHub access was revoked or expired. Reconnect GitHub.', updatedAt: new Date() }).where('id', '=', repo.integrationId).where('status', '=', 'CONNECTED').execute();
    } else {
      await trx.updateTable('integrationRepos').set({ lastError: e.message.slice(0, 300) }).where('id', '=', repo.id).execute();
    }
  });
  if (e.retryable) throw e; // BullMQ backs off and retries
  return { status: 'skipped', reason: e.code.toLowerCase() };
}

/** Every active repository of every connected integration, one at a time; one repo's failure never blocks the others. */
export async function syncAll(deps: IntegrationDeps): Promise<{ repos: number; synced: number; failed: number }> {
  const rows = await withContext(deps.db, {}, (trx) => sql<{ organizationId: string; repoId: string }>`SELECT organization_id AS "organizationId", repo_id AS "repoId" FROM job_sync_repos()`.execute(trx));
  let synced = 0;
  let failed = 0;
  for (const r of rows.rows) {
    try {
      if ((await syncRepo(deps, r.organizationId, r.repoId)).status === 'synced') synced++;
    } catch (e) {
      failed++;
      deps.log?.(`sync of repo ${r.repoId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { repos: rows.rows.length, synced, failed };
}

export async function processWebhook(deps: IntegrationDeps, orgId: string, eventId: string): Promise<{ status: 'processed' | 'ignored'; reason?: string }> {
  const now = (deps.now ?? (() => new Date()))();
  return withContext(deps.db, { orgId }, async (trx) => {
    const ev = await trx.selectFrom('webhookEvents').select(['id', 'repoId', 'eventType', 'status', 'payload']).where('id', '=', eventId).forUpdate().executeTakeFirst();
    if (!ev) return { status: 'ignored', reason: 'unknown event' } as const;
    if (ev.status !== 'RECEIVED') return { status: ev.status === 'PROCESSED' ? 'processed' : 'ignored', reason: 'already handled' } as const; // idempotent re-delivery of the job
    const done = async (status: 'PROCESSED' | 'IGNORED', reason?: string) => {
      await trx.updateTable('webhookEvents').set({ status, error: reason ?? null, processedAt: now }).where('id', '=', ev.id).execute();
      return { status: status === 'PROCESSED' ? 'processed' : 'ignored', reason } as const;
    };
    const r = await trx.selectFrom('integrationRepos as r').innerJoin('integrations as i', 'i.id', 'r.integrationId')
      .select(['r.id', 'r.organizationId', 'r.workspaceId', 'r.projectId', 'r.fullName', 'r.integrationId', 'r.active', 'i.status as integrationStatus', 'r.syncedUntil']).where('r.id', '=', ev.repoId).forUpdate('i').executeTakeFirst();
    if (!r || !r.active || r.integrationStatus !== 'CONNECTED') return done('IGNORED', 'integration disconnected');
    const repo: RepoState = { ...r, tokenEnc: null };

    const p = ev.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (ev.eventType === 'ping') return done('PROCESSED');
    const claimed = String(p.repository?.full_name ?? '').toLowerCase();
    if (claimed !== repo.fullName.toLowerCase()) return done('IGNORED', 'repository mismatch');

    let items: ExternalItem[] = [];
    if (ev.eventType === 'pull_request' && p.pull_request) items = [normalizePull(p.pull_request)];
    else if (ev.eventType === 'issues' && p.issue && !p.issue.pull_request) items = [normalizeIssue(p.issue)];
    else if (ev.eventType === 'push' && Array.isArray(p.commits)) {
      items = p.commits.slice(0, 100).map((c: Record<string, any>) => normalizeCommit({ sha: c.id, message: c.message, html_url: c.url, timestamp: c.timestamp, author: { username: c.author?.username } })); // eslint-disable-line @typescript-eslint/no-explicit-any
    } else return done('IGNORED', `unsupported event ${ev.eventType}`);

    const changed = await upsertItems(trx, repo, items, now);
    await autoLink(trx, repo, changed);
    await emitPrEvents(trx, repo, changed);
    return done('PROCESSED');
  });
}

export function createIntegrationProcessor(deps?: IntegrationDeps, google?: GoogleDeps) {
  const handler = async function process(job: Job<JobData>): Promise<unknown> {
    const t = job.data.type as EventType;
    if (t === 'integration.sync_requested.v1') {
      if (!deps) throw new Error('GitHub integration is not configured on this worker');
      const p = parseEventPayload(t, job.data.payload);
      return syncRepo(deps, p.organizationId, p.repoId);
    }
    if (t === 'integration.webhook_received.v1') {
      if (!deps) throw new Error('GitHub integration is not configured on this worker');
      const p = parseEventPayload(t, job.data.payload);
      return processWebhook(deps, p.organizationId, p.webhookEventId);
    }
    if (t === 'integration.google_sync_requested.v1') {
      if (!google) throw new Error('Google integration is not configured on this worker');
      const p = parseEventPayload(t, job.data.payload);
      return p.kind === 'CALENDAR' ? syncCalendar(google, p.organizationId, p.sourceId) : syncMailbox(google, p.organizationId, p.sourceId);
    }
    throw new Error(`integrations worker cannot handle ${t}`);
  };
  /** Retries are exhausted: make the failure visible instead of leaving a delivery in limbo. */
  handler.markExhausted = async (job: Job<JobData>, reason: string): Promise<void> => {
    const t = job.data.type as EventType;
    const db = (deps ?? google)!.db;
    if (t === 'integration.webhook_received.v1') {
      const p = parseEventPayload(t, job.data.payload);
      await withContext(db, { orgId: p.organizationId }, (trx) =>
        trx.updateTable('webhookEvents').set({ status: 'FAILED', error: reason.slice(0, 300), processedAt: new Date() }).where('id', '=', p.webhookEventId).where('status', '=', 'RECEIVED').execute());
    } else if (t === 'integration.sync_requested.v1') {
      const p = parseEventPayload(t, job.data.payload);
      await withContext(db, { orgId: p.organizationId }, (trx) =>
        trx.updateTable('integrationRepos').set({ lastError: reason.slice(0, 300) }).where('id', '=', p.repoId).execute());
    } else if (t === 'integration.google_sync_requested.v1') {
      const p = parseEventPayload(t, job.data.payload);
      await withContext(db, { orgId: p.organizationId }, async (trx) => {
        const lastError = reason.slice(0, 300);
        if (p.kind === 'CALENDAR') await trx.updateTable('calendarSources').set({ lastError }).where('id', '=', p.sourceId).execute();
        else await trx.updateTable('emailSources').set({ lastError }).where('id', '=', p.sourceId).execute();
      });
    }
  };
  return handler;
}
