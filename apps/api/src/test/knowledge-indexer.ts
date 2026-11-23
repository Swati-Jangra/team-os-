import type { AIProvider } from '@teamos/ai-core';
import { chunkText, htmlToText } from '@teamos/ai-core';
import { sql, withContext } from '@teamos/database';
import type { Harness } from './harness';

/**
 * Test stand-in for the worker's indexer: the API package cannot import the worker app, so this applies the same
 * steps (re-read the document, chunk, embed, replace chunks under an org-only "system" context). The real worker
 * processor is covered by apps/worker/src/knowledge.test.ts; this lets API tests exercise search end to end.
 */
export function createProcessorForTests(h: Harness, ai: AIProvider, orgId: string) {
  return async (docId: string) => {
    const st = (await withContext(h.t.db, { orgId }, (trx) =>
      sql<{ workspaceId: string; title: string; contentHtml: string; version: number; deleted: boolean }>`SELECT workspace_id AS "workspaceId", title, content_html AS "contentHtml", version, deleted FROM job_document_state(${docId}::uuid)`.execute(trx))).rows[0];
    await withContext(h.t.db, { orgId }, async (trx) => {
      await trx.deleteFrom('knowledgeChunks').where('sourceId', '=', docId).execute();
      if (!st || st.deleted) return;
      const chunks = chunkText(htmlToText(st.contentHtml));
      if (!chunks.length) return;
      const emb = await ai.embed(chunks.map((c) => [st.title, c.heading, c.content].filter(Boolean).join('\n')));
      await trx.insertInto('knowledgeChunks').values(chunks.map((c, i) => ({
        organizationId: orgId, workspaceId: st.workspaceId, sourceType: 'DOCUMENT' as const, sourceId: docId, chunkIndex: c.index,
        sourceTitle: st.title, heading: c.heading, content: c.content, embedding: emb.vectors[i]!, embeddingModel: emb.model,
        embeddingVersion: emb.version, sourceVersion: st.version,
      }))).execute();
    });
  };
}
