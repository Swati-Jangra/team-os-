-- 0004_notifications_jobs: in-app notifications, per-user preferences, and the narrow
-- SECURITY DEFINER helpers that background jobs need (they run without a user session).

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  category        text NOT NULL CHECK (category IN ('TASK_ASSIGNED','TASK_COMMENT','TASK_STATUS','TASK_DUE')),
  title           text NOT NULL,
  body            text,
  link            text,
  workspace_id    uuid,
  task_id         uuid,
  -- lets scheduled jobs be re-run safely: one notification per (user, key)
  dedupe_key      text,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key),
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id)
);
CREATE INDEX notifications_user_idx ON notifications(user_id, organization_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id, organization_id) WHERE read_at IS NULL;

-- Sparse: a missing row means "use the default" (defaults live in code, packages/validation).
CREATE TABLE notification_preferences (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   text NOT NULL CHECK (category IN ('TASK_ASSIGNED','TASK_COMMENT','TASK_STATUS','TASK_DUE')),
  in_app     boolean NOT NULL,
  email      boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

ALTER TABLE notifications            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- A user only ever sees / changes their own notifications, within the current org.
CREATE POLICY notif_select ON notifications FOR SELECT TO app_user
  USING (user_id = app_user_id() AND organization_id = app_org_id());
CREATE POLICY notif_update ON notifications FOR UPDATE TO app_user
  USING (user_id = app_user_id() AND organization_id = app_org_id())
  WITH CHECK (user_id = app_user_id() AND organization_id = app_org_id());
-- Background jobs create notifications for other members of the org they are processing.
-- The composite FK guarantees the recipient is a member of that same org.
CREATE POLICY notif_insert ON notifications FOR INSERT TO app_user
  WITH CHECK (organization_id = app_org_id());

CREATE POLICY notifprefs_all ON notification_preferences FOR ALL TO app_user
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

GRANT SELECT, INSERT, UPDATE ON notifications TO app_user;
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO app_user;

-- ---------- helpers for jobs (no user session, so they must bypass RLS — kept deliberately narrow) ----------

-- What the notification processor needs to know about a task. Returns nothing for deleted tasks.
CREATE FUNCTION job_task_context(p_task uuid) RETURNS TABLE (
  organization_id uuid, workspace_id uuid, project_id uuid, title text, identifier text,
  assignee_id uuid, reporter_id uuid, status task_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.organization_id, t.workspace_id, t.project_id, t.title, p.key || '-' || t.number,
         t.assignee_id, t.reporter_id, t.status
  FROM tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.id = p_task AND t.deleted_at IS NULL
$$;

-- People who have commented on a task (for "new comment" fan-out).
CREATE FUNCTION job_task_commenters(p_task uuid) RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT c.author_id FROM comments c WHERE c.task_id = p_task AND c.deleted_at IS NULL
$$;

-- Open tasks that are due within a day or already overdue, with an assignee.
CREATE FUNCTION job_tasks_due_soon(p_today date) RETURNS TABLE (
  task_id uuid, organization_id uuid, workspace_id uuid, project_id uuid, title text, identifier text,
  assignee_id uuid, due_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.organization_id, t.workspace_id, t.project_id, t.title, p.key || '-' || t.number,
         t.assignee_id, t.due_date
  FROM tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL
    AND t.assignee_id IS NOT NULL AND t.due_date IS NOT NULL
    AND t.status NOT IN ('DONE','CANCELLED')
    AND t.due_date <= p_today + 1
    AND t.due_date >= p_today - 7          -- don't nag about things overdue for more than a week
$$;

-- Housekeeping. Returns how many rows each step removed.
CREATE FUNCTION job_cleanup(p_now timestamptz) RETURNS TABLE (step text, removed bigint)
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
END $$;

REVOKE ALL ON FUNCTION job_task_context(uuid), job_task_commenters(uuid), job_tasks_due_soon(date),
  job_cleanup(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_task_context(uuid), job_task_commenters(uuid), job_tasks_due_soon(date),
  job_cleanup(timestamptz) TO app_user;
-- the cleanup job deletes from tables app_user cannot touch directly; the function runs as its owner.
