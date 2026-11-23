-- 0009_google: Google Calendar and Gmail on top of the 0008 integration plumbing (encrypted tokens, background-only credentials).
-- Rules enforced here:
--   * a calendar / mailbox source belongs to exactly ONE workspace; synced data inherits that workspace's visibility;
--   * users can only change what a person is meant to decide (email project link, item decision) - never synced content;
--   * decided email items are a permanent record (like meeting items).

ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check CHECK (provider IN ('GITHUB','GOOGLE_CALENDAR','GOOGLE_MAIL'));

-- ------------------------------------------------------------ calendar
CREATE TABLE calendar_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  integration_id  uuid NOT NULL REFERENCES integrations(id),
  workspace_id    uuid NOT NULL,
  calendar_id     text NOT NULL CHECK (length(calendar_id) BETWEEN 1 AND 300),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  sync_token      text,
  active          boolean NOT NULL DEFAULT true,
  last_synced_at  timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, calendar_id),
  UNIQUE (organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id)
);

CREATE TABLE calendar_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  source_id       uuid NOT NULL,
  external_id     text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 300),
  title           text NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  all_day         boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','tentative')),
  html_link       text,
  attendee_count  integer NOT NULL DEFAULT 0,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id),
  UNIQUE (organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id, source_id) REFERENCES calendar_sources(organization_id, workspace_id, id)
);
CREATE INDEX calendar_events_ws_time_idx ON calendar_events(workspace_id, starts_at);

-- a person links a synced event to a meeting record (1:1); both must be in the same workspace
CREATE TABLE meeting_calendar_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  meeting_id      uuid NOT NULL UNIQUE,
  event_id        uuid NOT NULL UNIQUE,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, workspace_id, meeting_id) REFERENCES meetings(organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id, event_id) REFERENCES calendar_events(organization_id, workspace_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------ email
CREATE TABLE email_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  integration_id  uuid NOT NULL UNIQUE REFERENCES integrations(id),
  workspace_id    uuid NOT NULL,
  project_id      uuid,
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  synced_until    timestamptz,
  active          boolean NOT NULL DEFAULT true,
  last_synced_at  timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id),
  FOREIGN KEY (organization_id, workspace_id, project_id) REFERENCES projects(organization_id, workspace_id, id)
);

CREATE TABLE email_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  source_id       uuid NOT NULL,
  external_id     text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  thread_id       text,
  subject         text NOT NULL,
  from_address    text,
  received_at     timestamptz NOT NULL,
  excerpt         text NOT NULL CHECK (length(excerpt) <= 8000),
  project_id      uuid,
  link_source     text CHECK (link_source IN ('AUTO','MANUAL')),
  status          text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','EXTRACTED','FAILED')),
  summary         text,
  failure_reason  text,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id),
  UNIQUE (organization_id, workspace_id, id),
  CHECK ((project_id IS NULL) = (link_source IS NULL)),
  FOREIGN KEY (organization_id, workspace_id, source_id) REFERENCES email_sources(organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id, project_id) REFERENCES projects(organization_id, workspace_id, id)
);
CREATE INDEX email_messages_ws_idx ON email_messages(workspace_id, received_at DESC);

CREATE TABLE email_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  message_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('DECISION','ACTION_ITEM')),
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
  FOREIGN KEY (organization_id, workspace_id, message_id) REFERENCES email_messages(organization_id, workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, workspace_id, task_id) REFERENCES tasks(organization_id, workspace_id, id)
);
CREATE INDEX email_items_message_idx ON email_items(message_id, created_at);

CREATE FUNCTION email_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'decided email items cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'PENDING' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a decided email item cannot change its decision' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER email_items_guard_trg BEFORE UPDATE OR DELETE ON email_items FOR EACH ROW EXECUTE FUNCTION email_items_guard();

-- ------------------------------------------------------------ RLS
ALTER TABLE calendar_sources        ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_calendar_links  ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sources           ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_items             ENABLE ROW LEVEL SECURITY;

CREATE POLICY calendar_sources_admin ON calendar_sources FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_is_org_admin(organization_id)) WITH CHECK (organization_id = app_org_id() AND app_is_org_admin(organization_id));
CREATE POLICY calendar_sources_system ON calendar_sources FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);
CREATE POLICY calendar_events_read ON calendar_events FOR SELECT TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY calendar_events_system ON calendar_events FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);
CREATE POLICY meeting_calendar_links_user ON meeting_calendar_links FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id)) WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));

CREATE POLICY email_sources_admin ON email_sources FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_is_org_admin(organization_id)) WITH CHECK (organization_id = app_org_id() AND app_is_org_admin(organization_id));
CREATE POLICY email_sources_system ON email_sources FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);
CREATE POLICY email_messages_user ON email_messages FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id)) WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY email_messages_system ON email_messages FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);
CREATE POLICY email_items_user ON email_items FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id)) WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY email_items_system ON email_items FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_user_id() IS NULL) WITH CHECK (organization_id = app_org_id() AND app_user_id() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_sources TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO app_user;
GRANT SELECT, INSERT, DELETE ON meeting_calendar_links TO app_user;
GRANT SELECT, INSERT, UPDATE ON email_sources TO app_user;
GRANT SELECT, INSERT ON email_messages TO app_user;
GRANT UPDATE (project_id, link_source, subject, summary, status, failure_reason, excerpt, from_address, thread_id, received_at, synced_at) ON email_messages TO app_user;
GRANT SELECT, INSERT, DELETE ON email_items TO app_user;
GRANT UPDATE (status, task_id, decided_by, decided_at, text, assignee_hint, due_date, priority) ON email_items TO app_user;

-- Scheduled sync entry points (SECURITY DEFINER: the scheduler has no org context).
CREATE FUNCTION job_sync_calendars() RETURNS TABLE (organization_id uuid, source_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.organization_id, s.id FROM calendar_sources s JOIN integrations i ON i.id = s.integration_id
  WHERE s.active AND i.status = 'CONNECTED' ORDER BY s.last_synced_at NULLS FIRST
$$;
CREATE FUNCTION job_sync_mailboxes() RETURNS TABLE (organization_id uuid, source_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.organization_id, s.id FROM email_sources s JOIN integrations i ON i.id = s.integration_id
  WHERE s.active AND i.status = 'CONNECTED' ORDER BY s.last_synced_at NULLS FIRST
$$;
-- Email -> task-key linking needs to resolve a project by key without a user session (one org AND one workspace).
CREATE FUNCTION job_find_project(p_org uuid, p_workspace uuid, p_key text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id FROM projects p WHERE p.organization_id = p_org AND p.workspace_id = p_workspace AND p.key = p_key AND p.deleted_at IS NULL LIMIT 1
$$;
REVOKE ALL ON FUNCTION job_sync_calendars(), job_sync_mailboxes(), job_find_project(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_sync_calendars(), job_sync_mailboxes(), job_find_project(uuid, uuid, text) TO app_user;
