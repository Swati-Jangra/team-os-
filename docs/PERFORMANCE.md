# Performance report (Phase 7)

**Read this first:** all numbers come from **one sandbox machine** running Postgres 16, Redis, the API (tsx, dev mode) and the load generator
**together**, so they are only useful as before/after comparisons and for spotting pathologies. They are not capacity figures for any real hardware.
Reproduce with `scripts/perf/seed.js` + `scripts/perf/load.js` against a **throw-away** database.

## Method

* Throw-away DB seeded with: 1 org, 1 workspace, 21 projects, **300,000 tasks in one project** (+100,000 elsewhere), 300,000 audit rows, 100,000 notifications, 20,000 knowledge chunks (256-dim embeddings).
* Postgres `log_min_duration_statement=40` to catch slow statements; `EXPLAIN (ANALYZE)` run **as `app_user` with RLS context** (plans differ from the superuser's).
* Closed-loop load: 10 concurrent clients, 60 requests per case, one logged-in Owner.

## Findings and fixes

| # | Finding (measured) | Root cause | Fix |
|---|---|---|---|
| 1 | Counting/listing a 300k-task project took **>10 s** per request | Every workspace RLS policy called `app_can_see_workspace(org, ws)` **once per row**. It is `SECURITY DEFINER`, so Postgres cannot inline it: two index probes per row. | Migration **0011**: `app_visible_workspaces()` returns the visible set; policies use `workspace_id IN (SELECT app_visible_workspaces())`, which the planner evaluates **once** (hashed subplan). 23 policies rewritten by the migration, which asserts each pins `organization_id = app_org_id()` (so semantics are identical). Count: ~11 s → ~0.2 s. All 79 prior RLS tests + 5 new ones (`visibility.rls.test.ts`) pass. |
| 2 | `POST` create task: **p50 1.1 s, p99 7.1 s** at 10 concurrent in the big project | Task numbering serialises on the project row lock; inside it, `max(position)` scanned the project (~180 ms) | Replaced by `ORDER BY position DESC LIMIT 1` + index `tasks_project_order_idx` (0012). p50 **83 ms**, p99 **444 ms**. |
| 3 | `GET tasks/mine` p50 497 ms | assignee index + sort | partial index `tasks_assignee_open_due_idx` (0012): **85 ms** |
| 4 | Project task list returned **all** tasks (unbounded) | design | capped at 2,000 rows per request; `meta.total` reports the real count (test: `projects.e2e.test.ts`). `data` is still an array, so the web app is unchanged. |
| 5 | Project list ran two correlated count subqueries per project | two passes over each project's tasks | one lateral pass with `FILTER` counters: 2.8 s → 1.4 s in the extreme case |

## Results, 300k-task project (10 concurrent clients, ms)

| Endpoint | Before p50 / p95 | After p50 / p95 |
|---|---|---|
| `GET /projects` (21 projects) | 2780 / 3563 | 1358 / 1516 |
| `GET /projects/:id/tasks` (cap 2000, 1.3 MB) | 2906 / 3239 | 1033 / 1477 |
| `GET …/tasks?status=DONE` | 2115 / 2944 | 1095 / 1419 |
| `GET …/tasks?q=…` (substring) | 1976 / 2201 | 2105 / 2620 (unchanged; see below) |
| `GET /tasks/mine` | 497 / 618 | 85 / 123 |
| `POST create task` | 1138 / 4910 (p99 6425) | 83 / 258 (p99 444) |
| `GET /notifications` | 67 / 89 | 89 / 125 (noise) |
| `GET /audit-logs` p1 / p500 | 114 / 202 | 127 / 217 |
| `POST /knowledge/search` (20k chunks) | 429 / 534 | 416 / 587 |
| `GET /auth/me`, `/health/ready` | 39, 12 | 44, 14 |

(The 300k-task project is an extreme; a realistic project of ≤2,000 tasks returns in a few milliseconds of database time — the single-statement plan for the capped list is 1.6 ms.)

## Things that did **not** work, and what that tells us

* **A trigram index for task search was tried and removed.** Under RLS, `ILIKE` is not *leakproof*, so Postgres will not use it as an index condition for `app_user`; search remains a filtered scan of one project (~0.4 s at 400k tasks).
* **Composite indexes leading with `(project_id, status)` are of limited value for `app_user`**: the enum equality operator is not leakproof either, so `status` stays a filter. Index on `(project_id, position)` and filter status instead (what 0012 does).
  Both effects come from RLS + non-leakproof operators; they are worth remembering for every future query on a table with RLS.

## Remaining limits (not fixed)

1. **Knowledge search is brute force**: cosine similarity is computed in SQL over `real[]` for every chunk of the org. 20k chunks → ~0.4 s p50 (25 req/s on this box); it scales linearly. Production-scale RAG needs **pgvector with an HNSW index**
   (the dev compose already uses the pgvector image, but it was **not available in the authoring sandbox**, so it was neither built nor tested). Plan: `embedding vector(N)` column + HNSW + the same RRF fusion.
2. Project list counts are computed on read (one pass per project). At very large project sizes, maintain counters.
3. The capped task list still moves up to ~1.3 MB per request when a project is huge; the board UI would need server-side pagination per column.
4. `audit_logs` deep pagination uses OFFSET (page 500 ≈ 200 ms at 300k rows); keyset pagination would be flat.
5. No connection-pool tuning, no read replicas, no caching layer; the DB pool size is the driver default of `createDb`.
6. No measurement of the worker under load (AI calls, indexing, large Gmail/GitHub syncs).
