import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, sql, withContext, type TestDatabase } from './index';

let t: TestDatabase;
const f = {} as Record<string, string>;

// tiny deterministic 4-d "embeddings"
const V = { rollout: [1, 0, 0, 0], budget: [0, 1, 0, 0], other: [0, 0, 1, 0] };

beforeAll(async () => {
  t = await createTestDatabase();
  const a = t.admin;
  const mkUser = async (e: string) => (await a.insertInto('users').values({ email: e, name: e, passwordHash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
  f.owner = await mkUser('owner@k.com');
  f.dev1 = await mkUser('dev1@k.com'); // member of ws1 only
  f.dev2 = await mkUser('dev2@k.com'); // member of ws2 only
  f.out = await mkUser('out@k.com'); // other org
  const mkOrg = async (n: string, o: string) => (await a.insertInto('organizations').values({ name: n, slug: n, createdBy: o }).returning('id').executeTakeFirstOrThrow()).id;
  f.org1 = await mkOrg('k1', f.owner);
  f.org2 = await mkOrg('k2', f.out);
  await a.insertInto('organizationMembers').values([
    { organizationId: f.org1, userId: f.owner, role: 'OWNER' },
    { organizationId: f.org1, userId: f.dev1, role: 'DEVELOPER' },
    { organizationId: f.org1, userId: f.dev2, role: 'DEVELOPER' },
    { organizationId: f.org2, userId: f.out, role: 'OWNER' },
  ]).execute();
  const mkWs = async (org: string, n: string) => (await a.insertInto('workspaces').values({ organizationId: org, name: n, slug: n }).returning('id').executeTakeFirstOrThrow()).id;
  f.ws1 = await mkWs(f.org1, 'w1');
  f.ws2 = await mkWs(f.org1, 'w2');
  f.wsOther = await mkWs(f.org2, 'w3');
  await a.insertInto('workspaceMembers').values([
    { organizationId: f.org1, workspaceId: f.ws1, userId: f.dev1, role: 'DEVELOPER' },
    { organizationId: f.org1, workspaceId: f.ws2, userId: f.dev2, role: 'DEVELOPER' },
  ]).execute();
  f.proj2 = (await a.insertInto('projects').values({ organizationId: f.org1, workspaceId: f.ws2, key: 'PB', name: 'p', createdBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  const mkDoc = async (ws: string, title: string) =>
    (await a.insertInto('documents').values({ organizationId: f.org1, workspaceId: ws, title, contentHtml: '<p>x</p>', createdBy: f.owner, updatedBy: f.owner }).returning('id').executeTakeFirstOrThrow()).id;
  f.doc1 = await mkDoc(f.ws1, 'Rollout plan');
  f.doc2 = await mkDoc(f.ws2, 'Budget memo');
  f.docGone = await mkDoc(f.ws1, 'Old rollout');
  await a.updateTable('documents').set({ deletedAt: new Date() }).where('id', '=', f.docGone).execute();
}, 60_000);
afterAll(async () => t?.destroy());

const chunk = (docId: string, ws: string, title: string, content: string, vec: number[], extra: object = {}) => ({
  organizationId: f.org1, workspaceId: ws, sourceType: 'DOCUMENT' as const, sourceId: docId, chunkIndex: 0, sourceTitle: title,
  content, embedding: vec, embeddingModel: 'm1', embeddingVersion: '1', sourceVersion: 1, ...extra,
});

const search = (ctx: { userId: string; orgId: string }, q: string, vec: number[], ws: string | null = null, model = 'm1') =>
  withContext(t.db, ctx, async (trx) => {
    const r = await sql<{ sourceId: string; score: number; vectorSim: number | null; keywordRank: number | null }>`
      SELECT * FROM knowledge_search(${q}, ${sql.raw(`ARRAY[${vec.join(',')}]::real[]`)}, ${model}, '1', ${ws}::uuid, 10)`.execute(trx);
    return r.rows;
  });

describe('documents RLS', () => {
  it('members see only documents in workspaces they can see; owner sees all; other org none', async () => {
    const titles = (ctx: { userId: string; orgId: string }) =>
      withContext(t.db, ctx, (trx) => trx.selectFrom('documents').select('title').where('deletedAt', 'is', null).orderBy('title').execute()).then((r) => r.map((x) => x.title));
    expect(await titles({ userId: f.dev1, orgId: f.org1 })).toEqual(['Rollout plan']);
    expect(await titles({ userId: f.dev2, orgId: f.org1 })).toEqual(['Budget memo']);
    expect(await titles({ userId: f.owner, orgId: f.org1 })).toEqual(['Budget memo', 'Rollout plan']);
    expect(await titles({ userId: f.out, orgId: f.org2 })).toEqual([]);
    expect(await titles({ userId: f.out, orgId: f.org1 })).toEqual([]);
  });

  it('cannot write into a workspace you cannot see, or link a project from another workspace', async () => {
    await expect(
      withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) =>
        trx.insertInto('documents').values({ organizationId: f.org1, workspaceId: f.ws2, title: 'x', createdBy: f.dev1, updatedBy: f.dev1 }).execute()),
    ).rejects.toThrow(/row-level security/);
    await expect(
      t.admin.insertInto('documents').values({ organizationId: f.org1, workspaceId: f.ws1, projectId: f.proj2, title: 'x', createdBy: f.owner, updatedBy: f.owner }).execute(),
    ).rejects.toThrow(/foreign key/);
  });

  it('version history is append-only for the app role', async () => {
    await withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) =>
      trx.insertInto('documentVersions').values({ organizationId: f.org1, workspaceId: f.ws1, documentId: f.doc1, version: 1, title: 'Rollout plan', contentHtml: '<p>x</p>', createdBy: f.dev1 }).execute());
    await expect(
      withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) => trx.updateTable('documentVersions').set({ title: 'tampered' }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) => trx.deleteFrom('documentVersions').execute()),
    ).rejects.toThrow(/permission denied/);
    // duplicate version number rejected
    await expect(
      withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) =>
        trx.insertInto('documentVersions').values({ organizationId: f.org1, workspaceId: f.ws1, documentId: f.doc1, version: 1, title: 'again', contentHtml: '', createdBy: f.dev1 }).execute()),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('knowledge index', () => {
  beforeAll(async () => {
    // the indexer writes under an ORG-only context (no user session)
    await withContext(t.db, { orgId: f.org1 }, (trx) =>
      trx.insertInto('knowledgeChunks').values([
        chunk(f.doc1, f.ws1, 'Rollout plan', 'The production rollout starts Monday with a canary release.', V.rollout),
        chunk(f.doc2, f.ws2, 'Budget memo', 'Quarterly budget forecast and headcount rollout costs.', V.budget),
        chunk(f.docGone, f.ws1, 'Old rollout', 'Deleted rollout notes should never be returned.', V.rollout),
      ]).execute());
  });

  it('indexer cannot write chunks for another org; chunks need a real workspace in the org', async () => {
    await expect(
      withContext(t.db, { orgId: f.org1 }, (trx) => trx.insertInto('knowledgeChunks').values(chunk(f.doc1, f.ws1, 't', 'c', V.other, { organizationId: f.org2 })).execute()),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withContext(t.db, { orgId: f.org1 }, (trx) => trx.insertInto('knowledgeChunks').values(chunk(f.doc1, f.wsOther, 't', 'c', V.other, { chunkIndex: 5 })).execute()),
    ).rejects.toThrow(/foreign key/);
  });

  it('search is filtered by the caller\'s CURRENT workspace visibility', async () => {
    const dev1 = await search({ userId: f.dev1, orgId: f.org1 }, 'rollout', V.rollout);
    expect(dev1.map((r) => r.sourceId)).toEqual([f.doc1]); // not Budget memo (ws2), not the deleted doc
    const dev2 = await search({ userId: f.dev2, orgId: f.org1 }, 'rollout', V.rollout);
    expect(dev2.map((r) => r.sourceId)).toEqual([f.doc2]);
    const owner = await search({ userId: f.owner, orgId: f.org1 }, 'rollout', V.rollout);
    expect(owner.map((r) => r.sourceId).sort()).toEqual([f.doc1, f.doc2].sort());
    expect(await search({ userId: f.out, orgId: f.org2 }, 'rollout', V.rollout)).toEqual([]);
    expect(await search({ userId: f.out, orgId: f.org1 }, 'rollout', V.rollout)).toEqual([]);
  });

  it('revoking workspace access immediately removes results (no stale metadata)', async () => {
    expect((await search({ userId: f.dev1, orgId: f.org1 }, 'rollout', V.rollout)).length).toBe(1);
    await t.admin.updateTable('workspaceMembers').set({ deletedAt: new Date() }).where('userId', '=', f.dev1).execute();
    expect(await search({ userId: f.dev1, orgId: f.org1 }, 'rollout', V.rollout)).toEqual([]);
    await t.admin.updateTable('workspaceMembers').set({ deletedAt: null }).where('userId', '=', f.dev1).execute();
  });

  it('fuses keyword and vector matches, honours workspace filter and ignores other embedding models', async () => {
    // vector-only hit (query words absent from text) and keyword-only hit (vector orthogonal)
    const vecOnly = await search({ userId: f.owner, orgId: f.org1 }, 'zzzz', V.budget);
    expect(vecOnly[0]!.sourceId).toBe(f.doc2);
    expect(vecOnly[0]!.keywordRank).toBeNull();
    const kwOnly = await search({ userId: f.owner, orgId: f.org1 }, 'canary', V.other);
    expect(kwOnly.map((r) => r.sourceId)).toEqual([f.doc1]);
    expect(kwOnly[0]!.vectorSim).toBeNull();
    // both signals rank above one
    const both = await search({ userId: f.owner, orgId: f.org1 }, 'rollout', V.rollout);
    expect(both[0]!.sourceId).toBe(f.doc1);
    expect(both[0]!.score).toBeGreaterThan(both[1]!.score);
    // workspace filter
    expect((await search({ userId: f.owner, orgId: f.org1 }, 'rollout', V.rollout, f.ws2)).map((r) => r.sourceId)).toEqual([f.doc2]);
    // a different embedding model never competes on vectors (keyword still works)
    const wrongModel = await search({ userId: f.owner, orgId: f.org1 }, 'zzzz', V.budget, null, 'other-model');
    expect(wrongModel).toEqual([]);
  });

  it('cosine_sim handles mismatched dimensions and zero vectors', async () => {
    const r = await sql<{ a: number | null; b: number | null; c: number | null }>`
      SELECT cosine_sim(ARRAY[1,0]::real[], ARRAY[1,0]::real[]) a, cosine_sim(ARRAY[1,0]::real[], ARRAY[1,0,0]::real[]) b,
             cosine_sim(ARRAY[0,0]::real[], ARRAY[1,0]::real[]) c`.execute(t.db);
    expect(r.rows[0]).toEqual({ a: 1, b: null, c: null });
  });

  it('indexer state helper reflects deletion without needing a user session', async () => {
    const r = await withContext(t.db, { orgId: f.org1 }, (trx) => sql<{ deleted: boolean; version: number }>`SELECT * FROM job_document_state(${f.docGone}::uuid)`.execute(trx));
    expect(r.rows[0]).toMatchObject({ deleted: true });
  });

  it('ai usage is insertable by the system and readable only by org admins', async () => {
    await withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) =>
      trx.insertInto('aiUsage').values({ organizationId: f.org1, userId: f.dev1, feature: 'ask', provider: 'local', model: 'm', inputTokens: 3, outputTokens: 4 }).execute());
    expect(await withContext(t.db, { userId: f.dev1, orgId: f.org1 }, (trx) => trx.selectFrom('aiUsage').selectAll().execute())).toHaveLength(0);
    expect(await withContext(t.db, { userId: f.owner, orgId: f.org1 }, (trx) => trx.selectFrom('aiUsage').selectAll().execute())).toHaveLength(1);
  });
});

describe('system (no-user) context', () => {
  it('can replace and delete its own org\'s chunks but never another org\'s, and a user context still cannot', async () => {
    const del = await withContext(t.db, { orgId: f.org2 }, (trx) => trx.deleteFrom('knowledgeChunks').executeTakeFirst());
    expect(Number(del.numDeletedRows)).toBe(0); // org2 has none, and cannot see org1's
    const own = await withContext(t.db, { orgId: f.org1 }, (trx) => trx.selectFrom('knowledgeChunks').select('id').execute());
    expect(own.length).toBeGreaterThan(0);
    // a signed-in user in the wrong org context sees nothing (the system policy needs NO user)
    expect(await withContext(t.db, { userId: f.out, orgId: f.org1 }, (trx) => trx.selectFrom('knowledgeChunks').select('id').execute())).toEqual([]);
  });
});
