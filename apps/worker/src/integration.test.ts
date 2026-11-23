import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { createTestDatabase, withContext, type TestDatabase } from '@teamos/database';
import { GitHubError, encryptSecret, type ExternalItem, type GitHubClient } from '@teamos/integrations';
import { createIntegrationProcessor, processWebhook, syncAll, syncRepo, type IntegrationDeps } from './integration.processor';
import type { JobData } from './queues';

let t: TestDatabase;
const f = {} as Record<string, string>;
const key = randomBytes(32);
const NOW = new Date('2026-07-10T09:00:00Z');

class FakeGitHub {
  pulls: ExternalItem[] = [];
  issues: ExternalItem[] = [];
  commits: ExternalItem[] = [];
  calls: string[] = [];
  fail: GitHubError | null = null;
  onList?: () => Promise<void>;
  async listPulls(token: string, repo: string, since: string | null) { this.calls.push(`pulls:${repo}:${since}`); await this.onList?.(); if (this.fail) throw this.fail; return this.pulls; }
  async listIssues() { if (this.fail) throw this.fail; return this.issues; }
  async listCommits() { if (this.fail) throw this.fail; return this.commits; }
}
let gh: FakeGitHub;
const deps = (): IntegrationDeps => ({ db: t.db, github: gh as unknown as GitHubClient, key, now: () => NOW });
const pr = (n: number, title: string, extra: Partial<ExternalItem> = {}): ExternalItem => ({
  kind: 'PULL_REQUEST', externalId: String(n), title, state: 'open', url: `https://github.com/acme/one/pull/${n}`, authorLogin: 'bob', headRef: null,
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-09T00:00:00Z', mergedAt: null, ...extra,
});

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const user = (await a.insertInto('users').values({ email: 'o@w.com', name: 'o', passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.org = (await a.insertInto('organizations').values({ name: 'w', slug: 'w', createdBy: user }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('organizationMembers').values({ organizationId: f.org, userId: user, role: 'OWNER' }).execute();
  const ws = async (n: string) => (await a.insertInto('workspaces').values({ organizationId: f.org, name: n, slug: n }).returning('id').executeTakeFirstOrThrow()).id;
  f.ws1 = await ws('w1'); f.ws2 = await ws('w2');
  const proj = async (w: string, k: string) => (await a.insertInto('projects').values({ organizationId: f.org, workspaceId: w, key: k, name: k, createdBy: user }).returning('id').executeTakeFirstOrThrow()).id;
  f.p1 = await proj(f.ws1, 'AA'); f.p2 = await proj(f.ws2, 'BB');
  const task = async (w: string, p: string, n: number) => (await a.insertInto('tasks').values({ organizationId: f.org, workspaceId: w, projectId: p, number: n, title: `t${n}`, reporterId: user }).returning('id').executeTakeFirstOrThrow()).id;
  f.t1 = await task(f.ws1, f.p1, 1); f.t2 = await task(f.ws2, f.p2, 1);
  f.int = (await a.insertInto('integrations').values({ organizationId: f.org, provider: 'GITHUB', accountLogin: 'acme', accountId: '1', connectedBy: user }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('integrationTokens').values({ integrationId: f.int, organizationId: f.org, tokenEnc: encryptSecret('gho_token', key, `token:${f.int}`) }).execute();
  f.repo = (await a.insertInto('integrationRepos').values({ organizationId: f.org, integrationId: f.int, workspaceId: f.ws1, fullName: 'acme/one', externalId: '10', webhookSecretEnc: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
}, 60_000);
afterAll(async () => t?.destroy());
beforeEach(async () => {
  gh = new FakeGitHub();
  await t.admin.deleteFrom('taskLinks').execute();
  await t.admin.deleteFrom('externalItems').execute();
  await t.admin.deleteFrom('webhookEvents').execute();
  await t.admin.deleteFrom('outboxEvents').where('type', 'like', 'github.%').execute();
  await t.admin.updateTable('integrations').set({ status: 'CONNECTED', lastError: null }).where('id', '=', f.int).execute();
  await t.admin.updateTable('integrationRepos').set({ active: true, syncedUntil: null, lastError: null }).where('id', '=', f.repo).execute();
});

const links = () => t.admin.selectFrom('taskLinks as l').innerJoin('externalItems as i', 'i.id', 'l.itemId').select(['l.taskId', 'l.source', 'i.externalId']).execute();
const items = () => t.admin.selectFrom('externalItems').select(['kind', 'externalId', 'title', 'state']).orderBy('kind').orderBy('externalId').execute();

describe('sync', () => {
  it('imports PRs/issues/commits, auto-links tasks of the SAME workspace only, and is idempotent', async () => {
    gh.pulls = [pr(1, 'AA-1 add login'), pr(2, 'fix BB-1 in other workspace'), pr(3, 'no task here', { headRef: 'feature/aa-1-oauth' })];
    gh.issues = [{ ...pr(9, 'Issue AA-1'), kind: 'ISSUE' }];
    gh.commits = [{ ...pr(0, 'AA-1: wire it'), kind: 'COMMIT', externalId: 'abc123', state: null }];
    const r = await syncRepo(deps(), f.org, f.repo);
    expect(r).toMatchObject({ status: 'synced', changed: 5 });
    expect(await items()).toHaveLength(5);
    const l = await links();
    expect(l.map((x) => x.externalId).sort()).toEqual(['1', '3', '9', 'abc123']); // 3 via branch name; PR 2 mentions a task in another workspace: no link
    expect(l.every((x) => x.taskId === f.t1 && x.source === 'AUTO')).toBe(true);
    const again = await syncRepo(deps(), f.org, f.repo);
    expect(again).toMatchObject({ status: 'synced', changed: 0, linked: 0 });
    expect(await items()).toHaveLength(5);
    expect(await links()).toHaveLength(4);
    const ev = await t.admin.selectFrom('outboxEvents').select('type').where('type', '=', 'github.pull_request.updated.v1').execute();
    expect(ev).toHaveLength(3); // one per changed PR, none on the unchanged re-run
    const repo = await t.admin.selectFrom('integrationRepos').select(['syncedUntil', 'lastError']).where('id', '=', f.repo).executeTakeFirstOrThrow();
    expect(repo.syncedUntil).toEqual(NOW);
  });

  it('is incremental: uses the cursor (with a small overlap) and applies changes once', async () => {
    gh.pulls = [pr(1, 'AA-1 add login')];
    await syncRepo(deps(), f.org, f.repo);
    gh.pulls = [pr(1, 'AA-1 add login', { state: 'merged', mergedAt: '2026-07-10T08:00:00Z', updatedAt: '2026-07-10T08:00:00Z' })];
    const r = await syncRepo(deps(), f.org, f.repo);
    expect(r.changed).toBe(1);
    expect((await items())[0]!.state).toBe('merged');
    expect(gh.calls[1]).toContain('2026-07-10T08:55:00.000Z'); // cursor (09:00) minus the 5 minute overlap
  });

  it('never goes back in time when data arrives out of order', async () => {
    gh.pulls = [pr(1, 'newer title', { updatedAt: '2026-07-09T12:00:00Z', state: 'closed' })];
    await syncRepo(deps(), f.org, f.repo);
    gh.pulls = [pr(1, 'older title', { updatedAt: '2026-07-08T12:00:00Z', state: 'open' })];
    await syncRepo(deps(), f.org, f.repo);
    expect(await items()).toEqual([expect.objectContaining({ title: 'newer title', state: 'closed' })]);
  });

  it('disconnected integrations and repositories are not synced', async () => {
    gh.pulls = [pr(1, 'AA-1')];
    await t.admin.updateTable('integrations').set({ status: 'DISCONNECTED' }).where('id', '=', f.int).execute();
    expect(await syncRepo(deps(), f.org, f.repo)).toEqual({ status: 'skipped', reason: 'not connected' });
    expect(await syncAll(deps())).toEqual({ repos: 0, synced: 0, failed: 0 });
    await t.admin.updateTable('integrations').set({ status: 'CONNECTED' }).where('id', '=', f.int).execute();
    await t.admin.updateTable('integrationRepos').set({ active: false }).where('id', '=', f.repo).execute();
    expect(await syncRepo(deps(), f.org, f.repo)).toMatchObject({ status: 'skipped' });
    expect(gh.calls).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it('a disconnect that happens while GitHub is being called wins: nothing is written', async () => {
    gh.pulls = [pr(1, 'AA-1')];
    gh.onList = async () => { await t.admin.updateTable('integrations').set({ status: 'DISCONNECTED' }).where('id', '=', f.int).execute(); };
    expect(await syncRepo(deps(), f.org, f.repo)).toEqual({ status: 'skipped', reason: 'disconnected during sync' });
    expect(await items()).toEqual([]);
  });

  it('a revoked token marks the integration ERROR and stops (no retry storm); transient errors are retried', async () => {
    gh.fail = new GitHubError('revoked', 'UNAUTHORIZED', 401, false);
    expect(await syncRepo(deps(), f.org, f.repo)).toEqual({ status: 'skipped', reason: 'unauthorized' });
    const i = await t.admin.selectFrom('integrations').select(['status', 'lastError']).where('id', '=', f.int).executeTakeFirstOrThrow();
    expect(i.status).toBe('ERROR');
    expect(i.lastError).toMatch(/Reconnect/);
    expect(await syncRepo(deps(), f.org, f.repo)).toMatchObject({ status: 'skipped' }); // ERROR integrations are not synced either
    await t.admin.updateTable('integrations').set({ status: 'CONNECTED' }).where('id', '=', f.int).execute();
    gh.fail = new GitHubError('rate limit', 'RATE_LIMITED', 429, true);
    await expect(syncRepo(deps(), f.org, f.repo)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await t.admin.selectFrom('integrationRepos').select('lastError').where('id', '=', f.repo).executeTakeFirstOrThrow()).lastError).toMatch(/rate limit/);
    gh.fail = new GitHubError('gone', 'NOT_FOUND', 404, false);
    expect(await syncRepo(deps(), f.org, f.repo)).toMatchObject({ status: 'skipped', reason: 'not_found' });
  });

  it('syncAll isolates failures per repository', async () => {
    const other = (await t.admin.insertInto('integrationRepos').values({ organizationId: f.org, integrationId: f.int, workspaceId: f.ws2, fullName: 'acme/two', externalId: '11', webhookSecretEnc: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
    gh.fail = new GitHubError('boom', 'SERVER', 502, true);
    const r = await syncAll({ ...deps(), log: () => undefined });
    expect(r).toEqual({ repos: 2, synced: 0, failed: 2 });
    await t.admin.deleteFrom('integrationRepos').where('id', '=', other).execute();
  });
});

describe('webhooks', () => {
  const store = async (eventType: string, payload: object, repoId = f.repo) =>
    (await t.admin.insertInto('webhookEvents').values({ organizationId: f.org, repoId, deliveryId: `d-${Math.random()}`, eventType, payload: JSON.stringify(payload) }).returning('id').executeTakeFirstOrThrow()).id;
  const prPayload = (title: string, repo = 'acme/one', state = 'open') => ({ action: 'opened', repository: { full_name: repo }, pull_request: { number: 5, title, state, html_url: 'https://x/5', user: { login: 'bob' }, head: { ref: 'feat' }, updated_at: '2026-07-10T08:00:00Z' } });
  const status = async (id: string) => (await t.admin.selectFrom('webhookEvents').select(['status', 'error']).where('id', '=', id).executeTakeFirstOrThrow());

  it('processes a pull_request delivery once: upsert, link, event', async () => {
    const id = await store('pull_request', prPayload('AA-1 webhook PR'));
    expect(await processWebhook(deps(), f.org, id)).toEqual({ status: 'processed' });
    expect(await items()).toEqual([expect.objectContaining({ kind: 'PULL_REQUEST', externalId: '5', title: 'AA-1 webhook PR' })]);
    expect(await links()).toHaveLength(1);
    expect((await t.admin.selectFrom('outboxEvents').select('id').where('type', '=', 'github.pull_request.updated.v1').execute())).toHaveLength(1);
    // the same job delivered again does nothing
    expect(await processWebhook(deps(), f.org, id)).toMatchObject({ reason: 'already handled' });
    expect((await t.admin.selectFrom('outboxEvents').select('id').where('type', '=', 'github.pull_request.updated.v1').execute())).toHaveLength(1);
  });

  it('handles issues, pushes and pings; ignores unsupported events', async () => {
    const issue = await store('issues', { repository: { full_name: 'acme/one' }, issue: { number: 8, title: 'AA-1 bug', state: 'open', html_url: 'u', user: { login: 'x' }, updated_at: '2026-07-10T08:00:00Z' } });
    const prIssue = await store('issues', { repository: { full_name: 'acme/one' }, issue: { number: 9, title: 'is a PR', pull_request: {} } });
    const push = await store('push', { repository: { full_name: 'acme/one' }, commits: [{ id: 'c1', message: 'AA-1 commit\n\nbody', url: 'u', timestamp: '2026-07-10T08:00:00Z', author: { username: 'bob' } }] });
    const ping = await store('ping', { zen: 'x' });
    const star = await store('star', { repository: { full_name: 'acme/one' } });
    for (const id of [issue, prIssue, push, ping, star]) await processWebhook(deps(), f.org, id);
    expect((await items()).map((i) => `${i.kind}:${i.externalId}`)).toEqual(['COMMIT:c1', 'ISSUE:8']);
    expect((await status(ping)).status).toBe('PROCESSED');
    expect(await status(prIssue)).toMatchObject({ status: 'IGNORED' });
    expect(await status(star)).toMatchObject({ status: 'IGNORED', error: 'unsupported event star' });
  });

  it('ignores payloads whose repository does not match the connection, and anything after disconnect', async () => {
    const wrong = await store('pull_request', prPayload('AA-1 spoof', 'evil/repo'));
    expect(await processWebhook(deps(), f.org, wrong)).toMatchObject({ status: 'ignored', reason: 'repository mismatch' });
    await t.admin.updateTable('integrations').set({ status: 'DISCONNECTED' }).where('id', '=', f.int).execute();
    const late = await store('pull_request', prPayload('AA-1 after disconnect'));
    expect(await processWebhook(deps(), f.org, late)).toMatchObject({ status: 'ignored', reason: 'integration disconnected' });
    expect(await items()).toEqual([]);
  });

  it('cannot be processed from another organization context', async () => {
    const id = await store('pull_request', prPayload('AA-1 x'));
    const otherOrg = (await t.admin.insertInto('organizations').values({ name: 'z', slug: 'z', createdBy: (await t.admin.selectFrom('users').select('id').executeTakeFirstOrThrow()).id }).returning('id').executeTakeFirstOrThrow()).id;
    expect(await processWebhook(deps(), otherOrg, id)).toMatchObject({ reason: 'unknown event' });
    expect((await status(id)).status).toBe('RECEIVED');
  });

  it('the queue handler dispatches events and marks exhausted deliveries FAILED', async () => {
    const proc = createIntegrationProcessor(deps());
    const id = await store('pull_request', prPayload('AA-1 via queue'));
    const job = (type: string, payload: object) => ({ data: { eventId: 'e', type, payload } }) as unknown as Job<JobData>;
    const wh = job('integration.webhook_received.v1', { organizationId: f.org, workspaceId: f.ws1, repoId: f.repo, webhookEventId: id });
    expect(await proc(wh)).toEqual({ status: 'processed' });
    const id2 = await store('pull_request', prPayload('x'));
    await proc.markExhausted(job('integration.webhook_received.v1', { organizationId: f.org, workspaceId: f.ws1, repoId: f.repo, webhookEventId: id2 }), 'database down');
    expect(await status(id2)).toEqual({ status: 'FAILED', error: 'database down' });
    gh.pulls = [pr(1, 'AA-1')];
    expect(await proc(job('integration.sync_requested.v1', { organizationId: f.org, workspaceId: f.ws1, repoId: f.repo, requestedByUserId: '00000000-0000-4000-8000-000000000001' }))).toMatchObject({ status: 'synced' });
    await expect(proc(job('member.joined.v1', {}))).rejects.toThrow(/cannot handle/);
  });
});

describe('credentials stay encrypted', () => {
  it('the stored token is ciphertext bound to its integration', async () => {
    const row = await t.admin.selectFrom('integrationTokens').select('tokenEnc').executeTakeFirstOrThrow();
    expect(row.tokenEnc).not.toContain('gho_token');
    await withContext(t.db, { userId: (await t.admin.selectFrom('users').select('id').executeTakeFirstOrThrow()).id, orgId: f.org }, async (trx) =>
      expect(await trx.selectFrom('integrationTokens').select('tokenEnc').execute()).toEqual([]));
  });
});
