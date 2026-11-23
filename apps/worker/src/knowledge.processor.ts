import type { Job } from 'bullmq';
import { sql, withContext, type Database } from '@teamos/database';
import { chunkText, htmlToText, type AIProvider } from '@teamos/ai-core';
import { parseEventPayload, type EventType } from '@teamos/event-contracts';
import type { JobData } from './queues';

export interface KnowledgeDeps {
  db: Database;
  ai: AIProvider;
  log: (m: string) => void;
}

export interface IndexResult {
  action: 'indexed' | 'unchanged' | 'removed' | 'skipped';
  chunks: number;
}

interface DocState {
  organizationId: string;
  workspaceId: string;
  title: string;
  contentHtml: string;
  version: number;
  deleted: boolean;
}

const EMBED_BATCH = 64;

/**
 * Keeps the knowledge index in step with documents.
 *  - Content is re-read from the database (job_document_state); the event only says WHICH document changed.
 *  - Idempotent: a version that is already indexed is a no-op; a stale event never overwrites a newer index.
 *  - Deletion propagates: deleted/missing documents lose all their chunks.
 *  - Provider errors are rethrown so BullMQ retries (embedding is the only external call, done before the write transaction).
 */
export function createKnowledgeProcessor(deps: KnowledgeDeps) {
  const loadState = (orgId: string, docId: string) =>
    withContext(deps.db, { orgId }, async (trx) => {
      const r = await sql<DocState>`SELECT organization_id AS "organizationId", workspace_id AS "workspaceId", title,
        content_html AS "contentHtml", version, deleted FROM job_document_state(${docId}::uuid)`.execute(trx);
      return r.rows[0] ?? null;
    });

  async function indexDocument(orgId: string, docId: string): Promise<IndexResult> {
    const state = await loadState(orgId, docId);
    // unknown id or a doc from another org: never index content across tenants
    if (!state || state.organizationId !== orgId) return removeDocument(orgId, docId);
    if (state.deleted) return removeDocument(orgId, docId);

    const have = await withContext(deps.db, { orgId }, (trx) =>
      trx.selectFrom('knowledgeChunks').select((eb) => [eb.fn.min('sourceVersion').as('lo'), eb.fn.max('sourceVersion').as('hi')])
        .where('sourceType', '=', 'DOCUMENT').where('sourceId', '=', docId).executeTakeFirst());
    if (have?.hi != null && Number(have.hi) >= state.version) {
      return { action: 'unchanged', chunks: 0 };
    }

    const chunks = chunkText(htmlToText(state.contentHtml));
    if (chunks.length === 0) return removeDocument(orgId, docId);

    const inputs = chunks.map((c) => [state.title, c.heading, c.content].filter(Boolean).join('\n'));
    const vectors: number[][] = [];
    let model = '';
    let version = '';
    let inTok = 0;
    for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
      const r = await deps.ai.embed(inputs.slice(i, i + EMBED_BATCH));
      vectors.push(...r.vectors);
      model = r.model;
      version = r.version;
      inTok += r.usage.inputTokens;
    }

    return withContext(deps.db, { orgId }, async (trx) => {
      // serialise indexers of the same document, then re-check: it may have changed or vanished while we embedded
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'kidx:' + docId}))`.execute(trx);
      const cur = (await sql<{ version: number; deleted: boolean }>`SELECT version, deleted FROM job_document_state(${docId}::uuid)`.execute(trx)).rows[0];
      if (!cur || cur.deleted) {
        await trx.deleteFrom('knowledgeChunks').where('sourceType', '=', 'DOCUMENT').where('sourceId', '=', docId).execute();
        return { action: 'removed', chunks: 0 } as IndexResult;
      }
      const existing = await trx.selectFrom('knowledgeChunks').select((eb) => eb.fn.max('sourceVersion').as('hi'))
        .where('sourceType', '=', 'DOCUMENT').where('sourceId', '=', docId).executeTakeFirst();
      if (existing?.hi != null && Number(existing.hi) >= state.version) return { action: 'unchanged', chunks: 0 } as IndexResult;
      if (cur.version !== state.version) return { action: 'skipped', chunks: 0 } as IndexResult; // newer event will index it

      await trx.deleteFrom('knowledgeChunks').where('sourceType', '=', 'DOCUMENT').where('sourceId', '=', docId).execute();
      await trx.insertInto('knowledgeChunks').values(
        chunks.map((c, i) => ({
          organizationId: orgId, workspaceId: state.workspaceId, sourceType: 'DOCUMENT' as const, sourceId: docId,
          chunkIndex: c.index, sourceTitle: state.title, heading: c.heading, content: c.content,
          embedding: vectors[i]!, embeddingModel: model, embeddingVersion: version, sourceVersion: state.version,
        })),
      ).execute();
      await trx.insertInto('aiUsage').values({ organizationId: orgId, userId: null, feature: 'embedding', provider: deps.ai.name, model, inputTokens: inTok, outputTokens: 0 }).execute();
      return { action: 'indexed', chunks: chunks.length } as IndexResult;
    });
  }

  async function removeDocument(orgId: string, docId: string): Promise<IndexResult> {
    const r = await withContext(deps.db, { orgId }, (trx) =>
      trx.deleteFrom('knowledgeChunks').where('sourceType', '=', 'DOCUMENT').where('sourceId', '=', docId).executeTakeFirst());
    return { action: 'removed', chunks: Number(r.numDeletedRows) };
  }

  return async function process(job: Job<JobData>): Promise<IndexResult> {
    const type = job.data.type as EventType;
    switch (type) {
      case 'document.created.v1':
      case 'document.updated.v1': {
        const p = parseEventPayload(type, job.data.payload) as { organizationId: string; documentId: string };
        return indexDocument(p.organizationId, p.documentId);
      }
      case 'document.deleted.v1': {
        const p = parseEventPayload(type, job.data.payload) as { organizationId: string; documentId: string };
        return removeDocument(p.organizationId, p.documentId);
      }
      default:
        deps.log(`knowledge: ignoring ${type}`);
        return { action: 'skipped', chunks: 0 };
    }
  };
}
