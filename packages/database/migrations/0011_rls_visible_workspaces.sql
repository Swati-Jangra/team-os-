-- Performance: RLS policies called app_can_see_workspace(org, ws) once PER ROW. That is a SECURITY DEFINER
-- function, so Postgres cannot inline it and ran two index probes per row (a 300k-row project took >10 s).
--
-- app_visible_workspaces() returns the SET of workspace ids the current user may see in the current org.
-- Used as `workspace_id IN (SELECT app_visible_workspaces())` the planner evaluates it ONCE per query
-- (an uncorrelated hashed subplan) and each row becomes a hash lookup.
--
-- Semantics are identical to app_can_see_workspace(row.organization_id, row.workspace_id) because every
-- policy that used it already ANDs `organization_id = app_org_id()`; this migration asserts that below.
CREATE FUNCTION app_visible_workspaces() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.id FROM workspaces w
  WHERE w.organization_id = app_org_id()
    AND app_user_id() IS NOT NULL
    AND EXISTS (SELECT 1 FROM organization_members om
                WHERE om.organization_id = w.organization_id AND om.user_id = app_user_id()
                  AND om.deleted_at IS NULL AND om.role IN ('OWNER','ADMIN'))
  UNION
  SELECT wm.workspace_id FROM workspace_members wm
  WHERE wm.organization_id = app_org_id() AND wm.user_id = app_user_id() AND wm.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION app_visible_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_visible_workspaces() TO app_user;

DO $$
DECLARE
  pol record;
  new_qual text;
  new_check text;
  n integer := 0;
  pat constant text := 'app_can_see_workspace\(([a-z_]+), ([a-z_]+)\)';
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
    WHERE schemaname = 'public' AND (qual LIKE '%app_can_see_workspace%' OR with_check LIKE '%app_can_see_workspace%')
  LOOP
    -- safety: the rewrite is only equivalent if the org is pinned by the same policy expression
    IF pol.qual IS NOT NULL AND pol.qual LIKE '%app_can_see_workspace%' AND pol.qual NOT LIKE '%organization_id = app_org_id()%' THEN
      RAISE EXCEPTION 'policy %.% does not pin organization_id; refusing to rewrite', pol.tablename, pol.policyname;
    END IF;
    IF pol.with_check IS NOT NULL AND pol.with_check LIKE '%app_can_see_workspace%' AND pol.with_check NOT LIKE '%organization_id = app_org_id()%' THEN
      RAISE EXCEPTION 'policy %.% (check) does not pin organization_id; refusing to rewrite', pol.tablename, pol.policyname;
    END IF;
    new_qual  := regexp_replace(pol.qual,       pat, '(\2 IN (SELECT app_visible_workspaces()))', 'g');
    new_check := regexp_replace(pol.with_check, pat, '(\2 IN (SELECT app_visible_workspaces()))', 'g');
    IF new_qual IS NOT NULL AND new_check IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)', pol.policyname, pol.schemaname, pol.tablename, new_qual, new_check);
    ELSIF new_qual IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', pol.policyname, pol.schemaname, pol.tablename, new_qual);
    ELSE
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', pol.policyname, pol.schemaname, pol.tablename, new_check);
    END IF;
    n := n + 1;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND (qual LIKE '%app_can_see_workspace%' OR with_check LIKE '%app_can_see_workspace%')) THEN
    RAISE EXCEPTION 'some policies still reference app_can_see_workspace';
  END IF;
  RAISE NOTICE 'rewrote % policies', n;
END
$$;
