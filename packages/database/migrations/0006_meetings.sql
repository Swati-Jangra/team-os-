-- 0006_meetings: meetings, transcripts, and AI-extracted items that need a human decision.
-- AI output lands in meeting_items as PENDING; it only becomes a task when a person with approval rights approves it.

CREATE TABLE meetings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  project_id      uuid,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  held_at         timestamptz,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PROCESSING','READY','FAILED')),
  transcript      text CHECK (transcript IS NULL OR length(transcript) <= 400000),
  transcript_source text CHECK (transcript_source IN ('PASTED','AUDIO')),
  audio_path      text,
  audio_mime      text,
  audio_bytes     integer,
  summary         text,
  failure_reason  text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id),
  FOREIGN KEY (organization_id, workspace_id, project_id) REFERENCES projects(organization_id, workspace_id, id)
);
CREATE INDEX meetings_ws_idx ON meetings(workspace_id, held_at DESC NULLS LAST) WHERE deleted_at IS NULL;

CREATE TABLE meeting_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  meeting_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('DECISION','ACTION_ITEM','BLOCKER')),
  text            text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  assignee_hint   text,
  due_date        date,
  priority        text CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  task_id         uuid,
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (task_id IS NULL OR (kind = 'ACTION_ITEM' AND status = 'APPROVED')),
  FOREIGN KEY (organization_id, workspace_id, meeting_id) REFERENCES meetings(organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id, task_id) REFERENCES tasks(organization_id, workspace_id, id)
);
CREATE INDEX meeting_items_meeting_idx ON meeting_items(meeting_id, created_at);

-- Decided items are a record of what people approved: they can never be deleted (re-processing replaces PENDING only).
CREATE FUNCTION meeting_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'decided meeting items cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'PENDING' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a decided meeting item cannot change its decision' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER meeting_items_guard_trg BEFORE UPDATE OR DELETE ON meeting_items FOR EACH ROW EXECUTE FUNCTION meeting_items_guard();

ALTER TABLE meetings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY meetings_all ON meetings FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY meeting_items_all ON meeting_items FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));

-- The processing worker has no user session (app.user_id unset): it may act only inside the org it is processing.
CREATE POLICY meetings_system ON meetings FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL)
  WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);
CREATE POLICY meeting_items_system ON meeting_items FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL)
  WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);

GRANT SELECT, INSERT, UPDATE ON meetings TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_items TO app_user;

-- Search must not return transcripts of deleted meetings. (Replaces the 0005 function; same signature.)
CREATE OR REPLACE FUNCTION knowledge_search(
  p_query text, p_embedding real[], p_model text, p_version text, p_workspace uuid, p_limit integer
) RETURNS TABLE (
  chunk_id uuid, workspace_id uuid, source_type text, source_id uuid, source_title text,
  heading text, content text, score double precision, vector_sim double precision, keyword_rank double precision)
LANGUAGE sql STABLE AS $$
  WITH visible AS (
    SELECT c.* FROM knowledge_chunks c
    WHERE (p_workspace IS NULL OR c.workspace_id = p_workspace)
      AND ((c.source_type = 'DOCUMENT' AND EXISTS (SELECT 1 FROM documents d WHERE d.id = c.source_id AND d.deleted_at IS NULL))
        OR (c.source_type = 'MEETING'  AND EXISTS (SELECT 1 FROM meetings m WHERE m.id = c.source_id AND m.deleted_at IS NULL AND m.status = 'READY')))
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

-- Live state for the worker (never trust event payloads for content).
CREATE FUNCTION job_meeting_state(p_meeting uuid) RETURNS TABLE (
  organization_id uuid, workspace_id uuid, title text, status text, transcript text,
  audio_path text, audio_mime text, deleted boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.organization_id, m.workspace_id, m.title, m.status, m.transcript, m.audio_path, m.audio_mime, m.deleted_at IS NOT NULL
  FROM meetings m WHERE m.id = p_meeting
$$;
REVOKE ALL ON FUNCTION job_meeting_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_meeting_state(uuid) TO app_user;
