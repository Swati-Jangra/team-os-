-- 0002_rls: tenant context functions, row-level security, grants, audit immutability.
-- Tenant context is supplied per transaction via set_config(..., true):
--   app.user_id, app.org_id, app.workspace_id
-- Owner (migrator) is NOT subject to RLS (no FORCE) so SECURITY DEFINER helpers
-- owned by it can read membership tables without recursion. app_user is subject to RLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RAISE EXCEPTION 'Role app_user must exist before running migrations (see infrastructure/docker/postgres-init.sql)';
  END IF;
END $$;

-- ---------- context accessors ----------
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

-- ---------- SECURITY DEFINER helpers (bypass RLS deliberately, narrow in scope) ----------
CREATE FUNCTION app_is_org_member(p_org uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE organization_id = p_org AND user_id = p_user AND deleted_at IS NULL)
$$;

CREATE FUNCTION app_org_role(p_org uuid, p_user uuid) RETURNS member_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM organization_members
  WHERE organization_id = p_org AND user_id = p_user AND deleted_at IS NULL
$$;

-- Org OWNER/ADMIN see every workspace in the org; everyone else only workspaces they belong to.
CREATE FUNCTION app_can_see_workspace(p_org uuid, p_ws uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
           SELECT 1 FROM organization_members om
           WHERE om.organization_id = p_org AND om.user_id = app_user_id()
             AND om.deleted_at IS NULL AND om.role IN ('OWNER','ADMIN'))
      OR EXISTS (
           SELECT 1 FROM workspace_members wm
           WHERE wm.workspace_id = p_ws AND wm.organization_id = p_org
             AND wm.user_id = app_user_id() AND wm.deleted_at IS NULL)
$$;

-- Pre-context lookups (login / invitation acceptance / outbox relay). Each returns only what it must.
CREATE FUNCTION auth_find_user_by_email(p_email text) RETURNS SETOF users
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM users WHERE email = lower(p_email) AND deleted_at IS NULL
$$;

CREATE FUNCTION invitation_find_by_token_hash(p_hash text) RETURNS SETOF invitations
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM invitations WHERE token_hash = p_hash
$$;

CREATE FUNCTION outbox_claim(p_limit integer) RETURNS SETOF outbox_events
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox_events SET locked_at = now(), attempts = attempts + 1
  WHERE id IN (
    SELECT id FROM outbox_events
    WHERE published_at IS NULL
      AND (locked_at IS NULL OR locked_at < now() - interval '60 seconds')
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED)
  RETURNING *
$$;

CREATE FUNCTION outbox_mark_published(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox_events SET published_at = now(), locked_at = NULL, last_error = NULL WHERE id = p_id
$$;

CREATE FUNCTION outbox_mark_failed(p_id uuid, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox_events SET locked_at = NULL, last_error = left(p_error, 1000) WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION auth_find_user_by_email(text), invitation_find_by_token_hash(text),
  outbox_claim(integer), outbox_mark_published(uuid), outbox_mark_failed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text), invitation_find_by_token_hash(text),
  outbox_claim(integer), outbox_mark_published(uuid), outbox_mark_failed(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION app_user_id(), app_org_id(), app_workspace_id(),
  app_is_org_member(uuid, uuid), app_org_role(uuid, uuid), app_can_see_workspace(uuid, uuid) TO app_user;

-- ---------- enable RLS ----------
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces           ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams                ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members         ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events        ENABLE ROW LEVEL SECURITY;

-- users: self, or a member of the current org
CREATE POLICY users_select ON users FOR SELECT TO app_user
  USING (id = app_user_id() OR app_is_org_member(app_org_id(), id));
CREATE POLICY users_insert ON users FOR INSERT TO app_user
  WITH CHECK (id = app_user_id());
CREATE POLICY users_update ON users FOR UPDATE TO app_user
  USING (id = app_user_id()) WITH CHECK (id = app_user_id());

-- organizations
CREATE POLICY orgs_select ON organizations FOR SELECT TO app_user
  USING (id = app_org_id() OR app_is_org_member(id, app_user_id()));
CREATE POLICY orgs_insert ON organizations FOR INSERT TO app_user
  WITH CHECK (id = app_org_id() AND app_user_id() IS NOT NULL);
CREATE POLICY orgs_update ON organizations FOR UPDATE TO app_user
  USING (id = app_org_id()) WITH CHECK (id = app_org_id());

-- organization_members: see own memberships (any org) + all members of the current org
CREATE POLICY om_select ON organization_members FOR SELECT TO app_user
  USING (organization_id = app_org_id() OR user_id = app_user_id());
CREATE POLICY om_insert ON organization_members FOR INSERT TO app_user
  WITH CHECK (organization_id = app_org_id());
CREATE POLICY om_update ON organization_members FOR UPDATE TO app_user
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
CREATE POLICY om_delete ON organization_members FOR DELETE TO app_user
  USING (organization_id = app_org_id());

-- workspaces
CREATE POLICY ws_select ON workspaces FOR SELECT TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, id));
CREATE POLICY ws_insert ON workspaces FOR INSERT TO app_user
  WITH CHECK (organization_id = app_org_id());
CREATE POLICY ws_update ON workspaces FOR UPDATE TO app_user
  USING (organization_id = app_org_id() AND app_can_see_workspace(organization_id, id))
  WITH CHECK (organization_id = app_org_id());

-- workspace_members
CREATE POLICY wm_select ON workspace_members FOR SELECT TO app_user
  USING (organization_id = app_org_id()
         AND (user_id = app_user_id() OR app_can_see_workspace(organization_id, workspace_id)));
CREATE POLICY wm_insert ON workspace_members FOR INSERT TO app_user
  WITH CHECK (organization_id = app_org_id());
CREATE POLICY wm_update ON workspace_members FOR UPDATE TO app_user
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
CREATE POLICY wm_delete ON workspace_members FOR DELETE TO app_user
  USING (organization_id = app_org_id());

-- teams / team_members (org-wide visibility)
CREATE POLICY teams_all ON teams FOR ALL TO app_user
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
CREATE POLICY tm_all ON team_members FOR ALL TO app_user
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());

-- roles: system roles readable by all; custom roles only within their org
CREATE POLICY roles_select ON roles FOR SELECT TO app_user
  USING (organization_id IS NULL OR organization_id = app_org_id());
CREATE POLICY roles_write ON roles FOR ALL TO app_user
  USING (organization_id = app_org_id() AND is_system = false)
  WITH CHECK (organization_id = app_org_id() AND is_system = false);

-- invitations
CREATE POLICY inv_all ON invitations FOR ALL TO app_user
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());

-- audit_logs: append + read within org (org-less rows are write-only for auth events)
CREATE POLICY audit_select ON audit_logs FOR SELECT TO app_user
  USING (organization_id = app_org_id());
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO app_user
  WITH CHECK (organization_id IS NULL OR organization_id = app_org_id());

-- outbox: insert-only for app_user; the relay reads via SECURITY DEFINER functions
CREATE POLICY outbox_insert ON outbox_events FOR INSERT TO app_user
  WITH CHECK (organization_id IS NULL OR organization_id = app_org_id());

-- ---------- audit immutability (applies to every role, incl. owner) ----------
CREATE FUNCTION audit_logs_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% not allowed)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();

-- ---------- grants ----------
GRANT USAGE ON SCHEMA public TO app_user;

-- identity tables: not tenant-scoped; sessions/email_tokens are looked up by secret hash
GRANT SELECT, INSERT, UPDATE ON users TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, email_tokens TO app_user;

GRANT SELECT, INSERT, UPDATE ON organizations TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organization_members, workspace_members, teams, team_members, invitations TO app_user;
GRANT SELECT, INSERT, UPDATE ON workspaces TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO app_user;
GRANT SELECT ON permissions, role_permissions TO app_user;

GRANT SELECT, INSERT ON audit_logs TO app_user;      -- no UPDATE / DELETE / TRUNCATE
GRANT INSERT ON outbox_events TO app_user;           -- reads only via definer functions
GRANT SELECT, INSERT ON processed_events TO app_user;
