-- 0008_integrations: third-party connections (GitHub first), encrypted credentials, signed webhooks, synced items, task links.
-- Design rules enforced here, not just in code:
--   * tokens/webhook secrets are stored encrypted; the token table is readable ONLY by the background worker context (never in a user request);
--   * a repository belongs to exactly one workspace, and synced data inherits that workspace's visibility;
--   * webhook deliveries are idempotent (unique delivery id per repository).

CREATE TABLE integrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  provider        text NOT NULL CHECK (provider IN ('GITHUB')),
  status          text NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED','DISCONNECTED','ERROR')),
  account_login   text NOT NULL,
  account_id      text NOT NULL,
  scopes          text NOT NULL DEFAULT '',
  connected_by    uuid NOT NULL REFERENCES users(id),
  last_synced_at  timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);
CREATE UNIQUE INDEX integrations_one_active ON integrations(organization_id, provider) WHERE status <> 'DISCONNECTED';

CREATE TABLE integration_tokens (
  integration_id  uuid PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  token_enc       text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_repos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  integration_id     uuid NOT NULL REFERENCES integrations(id),
  workspace_id       uuid NOT NULL,
  project_id         uuid,
  full_name          text NOT NULL CHECK (full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  external_id        text NOT NULL,
  webhook_id         bigint,
  webhook_secret_enc text NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  synced_until       timestamptz,
  last_synced_at     timestamptz,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, full_name),
  UNIQUE (organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id),
  FOREIGN KEY (organization_id, workspace_id, project_id) REFERENCES projects(organization_id, workspace_id, id)
);

CREATE TABLE external_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  repo_id         uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('PULL_REQUEST','ISSUE','COMMIT')),
  external_id     text NOT NULL,
  title           text NOT NULL,
  state           text CHECK (state IN ('open','closed','merged')),
  url             text NOT NULL,
  author_login    text,
  head_ref        text,
  created_ext_at  timestamptz,
  updated_ext_at  timestamptz,
  merged_at       timestamptz,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, kind, external_id),
  UNIQUE (organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id, repo_id) REFERENCES integration_repos(organization_id, workspace_id, id)
);
CREATE INDEX external_items_ws_idx ON external_items(workspace_id, kind, updated_ext_at DESC NULLS LAST);

CREATE TABLE task_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  task_id         uuid NOT NULL,
  item_id         uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('AUTO','MANUAL')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, item_id),
  FOREIGN KEY (organization_id, workspace_id, task_id) REFERENCES tasks(organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id, item_id) REFERENCES external_items(organization_id, workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX task_links_task_idx ON task_links(task_id);

CREATE TABLE webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repo_id         uuid NOT NULL REFERENCES integration_repos(id),
  delivery_id     text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 100),
  event_type      text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 50),
  status          text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  payload         jsonb NOT NULL,
  error           text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  UNIQUE (repo_id, delivery_id)
);
CREATE INDEX webhook_events_received_idx ON webhook_events(received_at);

-- CSRF protection for OAuth: single-use, short-lived, bound to the user and organization that started the flow.
CREATE TABLE oauth_states (
  state_hash      text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  provider        text NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- RLS
ALTER TABLE integrations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_repos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_links          ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events      ENABLE ROW LEVEL SECURITY;

-- who may manage integrations: org owners/admins (mirrors the integration:manage permission)
CREATE FUNCTION app_is_org_admin(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(app_org_role(p_org, app_user_id()) IN ('OWNER','ADMIN'), false)
$$;
GRANT EXECUTE ON FUNCTION app_is_org_admin(uuid) TO app_user;

CREATE POLICY integrations_admin ON integrations FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_is_org_admin(organization_id))
  WITH CHECK (organization_id = app_org_id() AND app_is_org_admin(organization_id));
CREATE POLICY integrations_system ON integrations FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);

-- credentials: NO user-context access at all (a bug in a request handler cannot read a token); only the background context
CREATE POLICY integration_tokens_system ON integration_tokens FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);

CREATE POLICY integration_repos_admin ON integration_repos FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_is_org_admin(organization_id))
  WITH CHECK (organization_id = app_org_id() AND app_is_org_admin(organization_id));
CREATE POLICY integration_repos_system ON integration_repos FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);

-- synced items are read-only for users and inherit workspace visibility
CREATE POLICY external_items_read ON external_items FOR SELECT TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY external_items_system ON external_items FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);

CREATE POLICY task_links_user ON task_links FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY task_links_system ON task_links FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);

CREATE POLICY webhook_events_system ON webhook_events FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);

GRANT SELECT, INSERT, UPDATE ON integrations TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_tokens TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_repos TO app_user;
GRANT SELECT, INSERT, UPDATE ON external_items TO app_user;
GRANT SELECT, INSERT, DELETE ON task_links TO app_user;
GRANT SELECT, INSERT, UPDATE ON webhook_events TO app_user;
GRANT SELECT, INSERT, DELETE ON oauth_states TO app_user;

-- ---------------------------------------------------------------- functions for unauthenticated / cross-org callers
-- The public webhook endpoint knows only the repository connection id from its URL. It gets the minimum needed to
-- verify the signature, and nothing is trusted until the signature matches.
CREATE FUNCTION webhook_repo_lookup(p_repo uuid) RETURNS TABLE (
  organization_id uuid, workspace_id uuid, integration_id uuid, full_name text, webhook_secret_enc text, repo_active boolean, integration_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.organization_id, r.workspace_id, r.integration_id, r.full_name, r.webhook_secret_enc, r.active, i.status
  FROM integration_repos r JOIN integrations i ON i.id = r.integration_id WHERE r.id = p_repo
$$;
-- Scheduled sync: every active repo of every CONNECTED integration.
CREATE FUNCTION job_sync_repos() RETURNS TABLE (organization_id uuid, repo_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.organization_id, r.id FROM integration_repos r JOIN integrations i ON i.id = r.integration_id
  WHERE r.active AND i.status = 'CONNECTED' ORDER BY r.last_synced_at NULLS FIRST
$$;
-- Auto-linking needs to resolve "APO-12" to a task without a user session. Scoped to one organization AND one workspace.
CREATE FUNCTION job_find_task(p_org uuid, p_workspace uuid, p_key text, p_number integer, p_project uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.organization_id = p_org AND t.workspace_id = p_workspace AND p.key = p_key AND t.number = p_number
    AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND (p_project IS NULL OR t.project_id = p_project)
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION webhook_repo_lookup(uuid), job_sync_repos(), job_find_task(uuid, uuid, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_repo_lookup(uuid), job_sync_repos(), job_find_task(uuid, uuid, text, integer, uuid) TO app_user;

-- Housekeeping: processed webhook deliveries and expired OAuth states. (Replaces the 0004 function; same signature.)
CREATE OR REPLACE FUNCTION job_cleanup(p_now timestamptz) RETURNS TABLE (step text, removed bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM sessions WHERE expires_at < p_now - interval '1 day' OR revoked_at < p_now - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT; step := 'sessions'; removed := n; RETURN NEXT;
  DELETE FROM email_tokens WHERE expires_at < p_now - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT; step := 'email_tokens'; removed := n; RETURN NEXT;
  DELETE FROM processed_events WHERE processed_at < p_now - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; step := 'processed_events'; removed := n; RETURN NEXT;
  DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < p_now - interval '14 days';
  GET DIAGNOSTICS n = ROW_COUNT; step := 'outbox_events'; removed := n; RETURN NEXT;
  DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < p_now - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT; step := 'notifications'; removed := n; RETURN NEXT;
  DELETE FROM webhook_events WHERE status <> 'RECEIVED' AND received_at < p_now - interval '14 days';
  GET DIAGNOSTICS n = ROW_COUNT; step := 'webhook_events'; removed := n; RETURN NEXT;
  DELETE FROM oauth_states WHERE expires_at < p_now - interval '1 day';
  GET DIAGNOSTICS n = ROW_COUNT; step := 'oauth_states'; removed := n; RETURN NEXT;
END $$;
