-- 0007_agent_actions: agent-proposed changes that need a human decision before they touch business data.
-- The database itself enforces the guarantees that matter:
--   * what was proposed (payload, target, version) can never be edited after the fact;
--   * a decision/execution can only move along allowed transitions (a rejected action can never run, an executed one never runs twice).

CREATE TABLE agent_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  project_id      uuid NOT NULL,
  agent           text NOT NULL CHECK (agent IN ('DEPENDENCY_RISK','TASK_MANAGEMENT')),
  action_type     text NOT NULL CHECK (action_type IN ('TASK_UPDATE_DUE','TASK_ASSIGN')),
  target_task_id  uuid NOT NULL,
  -- the target's version (tasks.updated_at as text, full microsecond precision) the proposal was based on
  target_version  text NOT NULL,
  payload         jsonb NOT NULL,
  payload_hash    text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  before_state    jsonb NOT NULL,
  after_state     jsonb NOT NULL,
  rationale       text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 1000),
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','EXECUTING','EXECUTED','FAILED','STALE')),
  proposed_by     uuid NOT NULL REFERENCES users(id),
  expires_at      timestamptz NOT NULL,
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_note   text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  executed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, workspace_id, project_id) REFERENCES projects(organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id, target_task_id) REFERENCES tasks(organization_id, workspace_id, id)
);
CREATE INDEX agent_actions_org_status_idx ON agent_actions(organization_id, status, created_at DESC);
CREATE INDEX agent_actions_project_idx ON agent_actions(project_id, created_at DESC);
-- one open proposal per task and kind: re-running an agent never piles up duplicates
CREATE UNIQUE INDEX agent_actions_open_uniq ON agent_actions(target_task_id, action_type) WHERE status = 'PENDING';

CREATE FUNCTION agent_actions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent actions are an audit record and cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.project_id <> OLD.project_id
     OR NEW.agent <> OLD.agent OR NEW.action_type <> OLD.action_type OR NEW.target_task_id <> OLD.target_task_id
     OR NEW.target_version <> OLD.target_version OR NEW.payload <> OLD.payload OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.before_state <> OLD.before_state OR NEW.after_state <> OLD.after_state OR NEW.proposed_by <> OLD.proposed_by
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'a proposed agent action cannot be modified' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING'   AND NEW.status IN ('APPROVED','REJECTED','EXPIRED'))
    OR (OLD.status = 'APPROVED'  AND NEW.status IN ('EXECUTING'))
    OR (OLD.status = 'EXECUTING' AND NEW.status IN ('EXECUTED','FAILED','STALE'))
    OR (OLD.status = 'FAILED'    AND NEW.status IN ('EXECUTING'))
  ) THEN
    RAISE EXCEPTION 'illegal agent action transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_actions_guard_trg BEFORE UPDATE OR DELETE ON agent_actions FOR EACH ROW EXECUTE FUNCTION agent_actions_guard();

ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_actions_all ON agent_actions FOR ALL TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id))
  WITH CHECK (organization_id = app_org_id() AND app_can_see_workspace(organization_id, workspace_id));
GRANT SELECT, INSERT, UPDATE ON agent_actions TO app_user;

-- Expiry sweep for the worker (no user session): PENDING proposals past their deadline become EXPIRED.
CREATE FUNCTION job_expire_agent_actions(p_now timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE agent_actions SET status = 'EXPIRED', updated_at = p_now WHERE status = 'PENDING' AND expires_at < p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION job_expire_agent_actions(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_expire_agent_actions(timestamptz) TO app_user;
