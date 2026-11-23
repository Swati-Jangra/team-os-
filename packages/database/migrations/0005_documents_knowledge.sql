-- 0005_documents_knowledge: documents with immutable version history, the knowledge index (chunks + embeddings),
-- hybrid keyword/vector search, and AI usage metering.
--
-- pgvector is NOT assumed. Embeddings are float4[] and cosine similarity is computed in SQL (brute force over the
-- chunks the caller may see). That is correct and tested, but O(chunks); at scale, swap the column for `vector`
-- + an HNSW index (see docs/PROJECT_STATUS.md).

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  project_id      uuid,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content_html    text NOT NULL DEFAULT '' CHECK (length(content_html) <= 500000),
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users(id),
  updated_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id),
  -- a linked project must be in the SAME workspace
  FOREIGN KEY (organization_id, workspace_id, project_id) REFERENCES projects(organization_id, workspace_id, id)
);
CREATE INDEX documents_ws_idx ON documents(workspace_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX documents_project_idx ON documents(project_id) WHERE deleted_at IS NULL AND project_id IS NOT NULL;

-- Every save appends a row; history is never edited or removed.
CREATE TABLE document_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  document_id     uuid NOT NULL,
  version         integer NOT NULL,
  title           text NOT NULL,
  content_html    text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version),
  FOREIGN KEY (organization_id, workspace_id, document_id) REFERENCES documents(organization_id, workspace_id, id)
);

CREATE TABLE knowledge_chunks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  workspace_id      uuid NOT NULL,
  source_type       text NOT NULL CHECK (source_type IN ('DOCUMENT','MEETING')),
  source_id         uuid NOT NULL,
  chunk_index       integer NOT NULL,
  source_title      text NOT NULL,
  heading           text,
  content           text NOT NULL,
  content_tsv       tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(source_title,'') || ' ' || coalesce(heading,'') || ' ' || content)) STORED,
  embedding         real[] NOT NULL,
  embedding_model   text NOT NULL,
  embedding_version text NOT NULL,
  source_version    integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, chunk_index),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id)
);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (content_tsv);
CREATE INDEX knowledge_chunks_source_idx ON knowledge_chunks(source_type, source_id);
CREATE INDEX knowledge_chunks_ws_idx ON knowledge_chunks(workspace_id);

CREATE TABLE ai_usage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id         uuid REFERENCES users(id),
  feature         text NOT NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_org_idx ON ai_usage(organization_id, created_at DESC);

-- ---------- RLS ----------
ALTER TABLE documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage           ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_all ON documents FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY docversions_select ON document_versions FOR SELECT TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY docversions_insert ON document_versions FOR INSERT TO app_user
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));

-- READ access to the index is always decided by the caller's CURRENT workspace visibility (never by stale
-- metadata copied into the chunk). WRITE access is org-scoped because the indexer runs without a user session
-- and is the only code that writes chunks; the composite FK keeps the workspace inside the org.
CREATE POLICY chunks_select ON knowledge_chunks FOR SELECT TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
-- The indexer (no user session: app.user_id unset) must be able to see its own org's chunks to replace/delete them
-- (UPDATE/DELETE also evaluate SELECT policies). Any request WITH a user falls under the policy above only.
CREATE POLICY chunks_select_system ON knowledge_chunks FOR SELECT TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL);
CREATE POLICY chunks_insert ON knowledge_chunks FOR INSERT TO app_user WITH CHECK (organization_id = app_org_id());
CREATE POLICY chunks_update ON knowledge_chunks FOR UPDATE TO app_user
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
CREATE POLICY chunks_delete ON knowledge_chunks FOR DELETE TO app_user USING (organization_id = app_org_id());

CREATE POLICY ai_usage_select ON ai_usage FOR SELECT TO app_user
  USING (organization_id = app_org_id() AND app_org_role(organization_id, app_user_id()) IN ('OWNER','ADMIN'));
CREATE POLICY ai_usage_insert ON ai_usage FOR INSERT TO app_user WITH CHECK (organization_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON documents TO app_user;
GRANT SELECT, INSERT ON document_versions TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_chunks TO app_user;
GRANT SELECT, INSERT ON ai_usage TO app_user;

-- ---------- search ----------

CREATE FUNCTION cosine_sim(a real[], b real[]) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN cardinality(a) <> cardinality(b) OR cardinality(a) = 0 THEN NULL ELSE
    (SELECT sum(x * y) / NULLIF(sqrt(sum(x * x)) * sqrt(sum(y * y)), 0) FROM unnest(a, b) AS t(x, y))
  END
$$;

-- Hybrid retrieval: keyword (tsvector) + vector (cosine), fused with reciprocal-rank fusion.
-- SECURITY INVOKER on purpose: the caller's RLS decides which chunks exist for them. Deleted documents are
-- excluded by joining the live source row. Only chunks embedded with the CURRENT model/version are compared.
CREATE FUNCTION knowledge_search(
  p_query text, p_embedding real[], p_model text, p_version text, p_workspace uuid, p_limit integer
) RETURNS TABLE (
  chunk_id uuid, workspace_id uuid, source_type text, source_id uuid, source_title text,
  heading text, content text, score double precision, vector_sim double precision, keyword_rank double precision)
LANGUAGE sql STABLE AS $$
  WITH visible AS (
    SELECT c.* FROM knowledge_chunks c
    WHERE (p_workspace IS NULL OR c.workspace_id = p_workspace)
      AND (c.source_type <> 'DOCUMENT' OR EXISTS (SELECT 1 FROM documents d WHERE d.id = c.source_id AND d.deleted_at IS NULL))
  ),
  vec AS (
    SELECT id, cosine_sim(embedding, p_embedding) AS sim,
           row_number() OVER (ORDER BY cosine_sim(embedding, p_embedding) DESC NULLS LAST) AS rnk
    FROM visible
    WHERE embedding_model = p_model AND embedding_version = p_version AND cosine_sim(embedding, p_embedding) > 0.05
    ORDER BY sim DESC LIMIT 50
  ),
  kw AS (
    SELECT id, ts_rank_cd(content_tsv, q) AS kr, row_number() OVER (ORDER BY ts_rank_cd(content_tsv, q) DESC) AS rnk
    FROM visible, websearch_to_tsquery('english', p_query) q
    WHERE content_tsv @@ q
    ORDER BY kr DESC LIMIT 50
  ),
  fused AS (
    SELECT coalesce(v.id, k.id) AS id,
           coalesce(1.0 / (60 + v.rnk), 0) + coalesce(1.0 / (60 + k.rnk), 0) AS score,
           v.sim, k.kr
    FROM vec v FULL OUTER JOIN kw k ON k.id = v.id
  )
  SELECT c.id, c.workspace_id, c.source_type, c.source_id, c.source_title, c.heading, c.content,
         f.score::double precision, f.sim, f.kr::double precision
  FROM fused f JOIN visible c ON c.id = f.id
  ORDER BY f.score DESC
  LIMIT least(greatest(p_limit, 1), 50)
$$;
GRANT EXECUTE ON FUNCTION cosine_sim(real[], real[]), knowledge_search(text, real[], text, text, uuid, integer) TO app_user;

-- ---------- helper for the indexer (no user session) ----------
-- Returns the live state of a document so the worker never trusts event payloads for content.
CREATE FUNCTION job_document_state(p_doc uuid) RETURNS TABLE (
  organization_id uuid, workspace_id uuid, title text, content_html text, version integer, deleted boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.organization_id, d.workspace_id, d.title, d.content_html, d.version, d.deleted_at IS NOT NULL
  FROM documents d WHERE d.id = p_doc
$$;
REVOKE ALL ON FUNCTION job_document_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_document_state(uuid) TO app_user;
