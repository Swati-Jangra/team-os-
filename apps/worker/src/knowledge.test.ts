import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { AIProviderError, LocalProvider, type AIProvider } from '@teamos/ai-core';
import { createTestDatabase, type TestDatabase } from '@teamos/database';
import { createKnowledgeProcessor } from './knowledge.processor';
import type { JobData } from './queues';

let t: TestDatabase;
const f = {} as Record<string, string>;
let n = 0;
const uuidN = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const job = (type: string, payload: object) => ({ data: { eventId: uuidN(), type, payload } }) as unknown as Job<JobData>;
const ev = (type: 'created' | 'updated' | 'deleted', docId: string, version = 1, orgId = f.org) =>
  job(`document.${type}.v1`, { organizationId: orgId, workspaceId: f.ws, documentId: docId, version, actorUserId: f.user });

class CountingProvider extends LocalProvider {
  embeds = 0;
  fail: AIProviderError | null = null;
  override async embed(texts: string[]) {
    this.embeds++;
    if (this.fail) throw this.fail;
    return super.embed(texts);
  }
}
let ai: CountingProvider;
let proc: ReturnType<typeof createKnowledgeProcessor>;

const chunks = (docId: string) =>
  t.admin.selectFrom('knowledgeChunks').select(['content', 'sourceVersion', 'heading', 'chunkIndex']).where('sourceId', '=', docId).orderBy('chunkIndex').execute();
const mkDoc = async (title: string, html: string) =>
  (await t.admin.insertInto('documents').values({ organizationId: f.org, workspaceId: f.ws, title, contentHtml: html, createdBy: f.user, updatedBy: f.user }).returning('id').executeTakeFirstOrThrow()).id;

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  f.user = (await a.insertInto('users').values({ email: 'k@x.com', name: 'K', passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.org = (await a.insertInto('organizations').values({ name: 'o', slug: 'o', createdBy: f.user }).returning('id').executeTakeFirstOrThrow()).id;
  f.org2 = (await a.insertInto('organizations').values({ name: 'o2', slug: 'o2', createdBy: f.user }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('organizationMembers').values({ organizationId: f.org, userId: f.user, role: 'OWNER' }).execute();
  f.ws = (await a.insertInto('workspaces').values({ organizationId: f.org, name: 'w', slug: 'w' }).returning('id').executeTakeFirstOrThrow()).id;
  ai = new CountingProvider();
  proc = createKnowledgeProcessor({ db: t.db, ai: ai as AIProvider, log: () => undefined });
}, 60_000);
afterAll(async () => t?.destroy());

describe('knowledge indexer', () => {
  it('indexes a document into heading-aware chunks with embeddings and records usage', async () => {
    const id = await mkDoc('Launch plan', '<h2>Rollout</h2><p>Canary release first, then full rollout.</p><h2>Risks</h2><p>Database migration may be slow.</p>');
    const r = await proc(ev('created', id));
    expect(r).toMatchObject({ action: 'indexed' });
    const rows = await chunks(id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((c) => c.heading)).toContain('Risks');
    expect(rows.every((c) => c.sourceVersion === 1)).toBe(true);
    const emb = await t.admin.selectFrom('knowledgeChunks').select(['embedding', 'embeddingModel']).where('sourceId', '=', id).executeTakeFirstOrThrow();
    expect(emb.embedding).toHaveLength(256);
    expect(emb.embeddingModel).toBe('local-hash-256');
    expect(await t.admin.selectFrom('aiUsage').select('feature').where('feature', '=', 'embedding').execute()).not.toHaveLength(0);
  });

  it('is idempotent: a re-delivered event does not re-embed or duplicate', async () => {
    const id = await mkDoc('Idem', '<p>Same content here.</p>');
    await proc(ev('created', id));
    const before = ai.embeds;
    expect(await proc(ev('created', id))).toMatchObject({ action: 'unchanged' });
    expect(ai.embeds).toBe(before);
    expect(await chunks(id)).toHaveLength(1);
  });

  it('re-indexes on a new version (old chunks replaced) and ignores stale events', async () => {
    const id = await mkDoc('Evolving', '<p>first draft about apples</p>');
    await proc(ev('created', id));
    await t.admin.updateTable('documents').set({ contentHtml: '<p>second draft about oranges</p>', version: 2 }).where('id', '=', id).execute();
    expect(await proc(ev('updated', id, 2))).toMatchObject({ action: 'indexed' });
    let rows = await chunks(id);
    expect(rows.map((c) => c.content).join(' ')).toContain('oranges');
    expect(rows.map((c) => c.content).join(' ')).not.toContain('apples');
    expect(rows.every((c) => c.sourceVersion === 2)).toBe(true);
    // a late-arriving v1 event must not roll the index back
    expect(await proc(ev('updated', id, 1))).toMatchObject({ action: 'unchanged' });
    rows = await chunks(id);
    expect(rows[0]!.sourceVersion).toBe(2);
  });

  it('propagates deletion, including when the delete event is missed (doc already gone)', async () => {
    const id = await mkDoc('Doomed', '<p>temporary notes</p>');
    await proc(ev('created', id));
    expect(await chunks(id)).toHaveLength(1);
    await t.admin.updateTable('documents').set({ deletedAt: new Date() }).where('id', '=', id).execute();
    expect(await proc(ev('deleted', id))).toMatchObject({ action: 'removed' });
    expect(await chunks(id)).toHaveLength(0);
    // an "updated" event for a soft-deleted doc also clears (and never re-adds) chunks
    await t.admin.insertInto('knowledgeChunks').values({ organizationId: f.org, workspaceId: f.ws, sourceType: 'DOCUMENT', sourceId: id, chunkIndex: 0, sourceTitle: 'x', content: 'stale', embedding: [1], embeddingModel: 'm', embeddingVersion: '1', sourceVersion: 1 }).execute();
    await proc(ev('updated', id, 2));
    expect(await chunks(id)).toHaveLength(0);
  });

  it('empty documents leave no chunks', async () => {
    const id = await mkDoc('Blank', '<p>   </p>');
    expect(await proc(ev('created', id))).toMatchObject({ action: 'removed' });
    expect(await chunks(id)).toHaveLength(0);
  });

  it('never indexes a document through another organization\'s event', async () => {
    const id = await mkDoc('Tenant A secret', '<p>confidential</p>');
    await proc(ev('created', id, 1, f.org2));
    expect(await chunks(id)).toHaveLength(0);
  });

  it('provider failures are rethrown for retry and leave the existing index intact', async () => {
    const id = await mkDoc('Flaky', '<p>version one text</p>');
    await proc(ev('created', id));
    await t.admin.updateTable('documents').set({ contentHtml: '<p>version two text</p>', version: 2 }).where('id', '=', id).execute();
    ai.fail = new AIProviderError('AI provider returned 503', true, 503);
    await expect(proc(ev('updated', id, 2))).rejects.toThrow(/503/);
    expect((await chunks(id))[0]!.content).toContain('version one');
    ai.fail = null;
    expect(await proc(ev('updated', id, 2))).toMatchObject({ action: 'indexed' });
    expect((await chunks(id))[0]!.content).toContain('version two');
  });
});
