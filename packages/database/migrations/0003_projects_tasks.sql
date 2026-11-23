-- 0003_projects_tasks: projects, milestones, tasks, dependencies, comments, activity.
-- Every table carries organization_id AND workspace_id; composite FKs make it impossible for a
-- child row to point at a parent in another org/workspace. RLS: a row is visible only if the
-- caller may see its workspace (org OWNER/ADMIN, or workspace member).

CREATE TYPE project_status  AS ENUM ('PLANNING','ACTIVE','ON_HOLD','COMPLETED','ARCHIVED');
CREATE TYPE milestone_status AS ENUM ('OPEN','COMPLETED');
CREATE TYPE task_status     AS ENUM ('BACKLOG','TODO','IN_PROGRESS','IN_REVIEW','DONE','CANCELLED');
CREATE TYPE task_priority   AS ENUM ('LOW','MEDIUM','HIGH','URGENT');

-- the parent workspaces table needs a (org, workspace-id) key for composite FKs: already UNIQUE(organization_id, id)

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  key             text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name            text NOT NULL,
  description     text,
  status          project_status NOT NULL DEFAULT 'PLANNING',
  owner_id        uuid,
  start_date      date,
  due_date        date,
  task_seq        integer NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date),
  UNIQUE (organization_id, workspace_id, id),
  UNIQUE (workspace_id, key),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id),
  FOREIGN KEY (organization_id, owner_id) REFERENCES organization_members(organization_id, user_id)
);
CREATE INDEX projects_ws_idx ON projects(workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE milestones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  project_id      uuid NOT NULL,
  name            text NOT NULL,
  description     text,
  due_date        date,
  status          milestone_status NOT NULL DEFAULT 'OPEN',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, workspace_id, project_id, id),
  FOREIGN KEY (organization_id, workspace_id, project_id) REFERENCES projects(organization_id, workspace_id, id)
);
CREATE INDEX milestones_project_idx ON milestones(project_id) WHERE deleted_at IS NULL;

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  project_id      uuid NOT NULL,
  milestone_id    uuid,
  number          integer NOT NULL,
  title           text NOT NULL,
  description     text,
  status          task_status NOT NULL DEFAULT 'TODO',
  priority        task_priority NOT NULL DEFAULT 'MEDIUM',
  assignee_id     uuid,
  reporter_id     uuid NOT NULL,
  start_date      date,
  due_date        date,
  estimate_hours  numeric(7,2) CHECK (estimate_hours IS NULL OR estimate_hours >= 0),
  labels          text[] NOT NULL DEFAULT '{}',
  position        double precision NOT NULL DEFAULT 0,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date),
  UNIQUE (project_id, number),
  UNIQUE (organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id, project_id) REFERENCES projects(organization_id, workspace_id, id),
  -- a milestone must belong to the SAME project
  FOREIGN KEY (organization_id, workspace_id, project_id, milestone_id)
    REFERENCES milestones(organization_id, workspace_id, project_id, id),
  FOREIGN KEY (organization_id, assignee_id) REFERENCES organization_members(organization_id, user_id),
  FOREIGN KEY (organization_id, reporter_id) REFERENCES organization_members(organization_id, user_id)
);
CREATE INDEX tasks_project_status_idx ON tasks(project_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_assignee_idx ON tasks(assignee_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_milestone_idx ON tasks(milestone_id) WHERE deleted_at IS NULL;

CREATE TABLE task_dependencies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  workspace_id       uuid NOT NULL,
  task_id            uuid NOT NULL,   -- the blocked task
  depends_on_task_id uuid NOT NULL,   -- the blocker
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (task_id <> depends_on_task_id),
  UNIQUE (task_id, depends_on_task_id),
  FOREIGN KEY (organization_id, workspace_id, task_id)            REFERENCES tasks(organization_id, workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, workspace_id, depends_on_task_id) REFERENCES tasks(organization_id, workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX task_deps_blocker_idx ON task_dependencies(depends_on_task_id);

CREATE TABLE comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  task_id         uuid NOT NULL,
  author_id       uuid NOT NULL,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  edited_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  FOREIGN KEY (organization_id, workspace_id, task_id) REFERENCES tasks(organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, author_id) REFERENCES organization_members(organization_id, user_id)
);
CREATE INDEX comments_task_idx ON comments(task_id, created_at) WHERE deleted_at IS NULL;

-- Per-project/task activity feed, readable by anyone who can see the workspace (unlike audit_logs,
-- which is an admin-only compliance record). Append-only.
CREATE TABLE activity_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  project_id      uuid NOT NULL,
  task_id         uuid,
  actor_type      actor_type NOT NULL DEFAULT 'USER',
  actor_id        uuid,
  action          text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, workspace_id, project_id) REFERENCES projects(organization_id, workspace_id, id)
);
CREATE INDEX activity_project_idx ON activity_events(project_id, created_at DESC);
CREATE INDEX activity_task_idx ON activity_events(task_id, created_at DESC) WHERE task_id IS NOT NULL;

CREATE FUNCTION activity_events_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only (% not allowed)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER activity_no_update_delete BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION activity_events_block_mutation();

-- ---------- RLS ----------
ALTER TABLE projects          ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_events   ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_all ON projects FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY milestones_all ON milestones FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY tasks_all ON tasks FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY task_deps_all ON task_dependencies FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY comments_all ON comments FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY activity_select ON activity_events FOR SELECT TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
CREATE POLICY activity_insert ON activity_events FOR INSERT TO app_user
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));

-- ---------- grants (no hard DELETE on business tables except dependency edges) ----------
GRANT SELECT, INSERT, UPDATE ON projects, milestones, tasks, comments TO app_user;
GRANT SELECT, INSERT, DELETE ON task_dependencies TO app_user;
GRANT SELECT, INSERT ON activity_events TO app_user;
