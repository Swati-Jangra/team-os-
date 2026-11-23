-- Found by the Phase 7 load run (300k tasks in one project):
-- * Creating a task computed max(position) of its column with a scan over the whole project while holding the
--   project row lock that serialises task numbering (~180 ms inside the lock at 300k tasks), so concurrent
--   creates queued. The code now does ORDER BY position DESC LIMIT 1, served by tasks_project_order_idx below.
--   NOTE: under RLS the enum comparison `status = 'X'` is not leakproof, so Postgres will not use `status` as an
--   index condition for app_user; composite indexes that lead with (project_id, status) are therefore of limited
--   use for the application role. Keep status as a filter, not an index column.
-- * "my tasks" (assignee + not done, ordered by due date) used the assignee index then sorted.
CREATE INDEX tasks_assignee_open_due_idx ON tasks(assignee_id, due_date NULLS LAST) WHERE deleted_at IS NULL AND status NOT IN ('DONE','CANCELLED');
-- * Task title search (?q=) is ILIKE '%x%'. A trigram index was tried and is NOT used for app_user: ILIKE is not
--   leakproof, so under RLS it can only be a filter. Search therefore scans one project's tasks (~400 ms at 400k
--   tasks, negligible at realistic sizes); a leakproof alternative is future work (see docs/PERFORMANCE.md).
CREATE INDEX tasks_project_order_idx ON tasks(project_id, position, number) WHERE deleted_at IS NULL;
