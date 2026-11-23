# TeamOS AI — Project Status

_Last updated: 2026-11-21_

## Phase 1 — Foundation, auth, organizations, workspaces, RBAC, dashboard: **COMPLETE (with caveats below)**

### Verified
- `pnpm typecheck`: 16/16 tasks pass. `pnpm test`: **115 tests pass** (permissions 14, shared 9, validation 7, event-contracts 3, config 3, database/RLS 24, api e2e 37, worker 8, web 10).
- `next build` succeeds (17 routes).
- Manual end-to-end with a real browser (Playwright) against live API + Postgres + Redis: register → verify email → login → create org → create workspace → invite → second user registers/verifies/logs in → accepts invite → owner sees the new member. No console/page errors. Checked light, dark and mobile screenshots.

### Delivered
- Monorepo (pnpm + Turborepo), CI workflow, docker-compose (pgvector, redis, mailpit, minio).
- PostgreSQL schema + RLS (tenant isolation proven under concurrency), append-only audit log, transactional outbox.
- Auth: argon2id, server-side sessions (httpOnly cookie), CSRF, email verification, password reset, lockout, rate limiting, no account enumeration.
- Organizations, workspaces, members, invitations, 7 system roles (RBAC enforced server-side), audit log API.
- Worker: outbox relay → BullMQ → email processor (idempotent, retries, DLQ).
- Web: login, register, forgot/reset password, verify email, accept invite, org + workspace onboarding, dashboard, workspaces (list/detail/settings), team members (invite/role/remove/revoke), roles matrix, audit logs, org settings. Design tokens, light/dark, responsive.

### Deviations / known gaps (honest list)
1. **Prisma replaced by Kysely + SQL migrations** (sandbox could not download Prisma binaries). User-approved. DB types are hand-maintained.
2. **docker-compose is untested** — no Docker daemon in the build sandbox. Verification used locally started Postgres 16 and Redis. pgvector is not used yet (Phase 4).
3. **Worker not exercised against a real SMTP server** in the browser run; email delivery is covered by worker tests (mock transport). Verification/invite tokens in the e2e run were read from the outbox table.
4. **Custom roles are not implemented** — the Roles page is a read-only matrix of the 7 system roles.
5. **No ESLint config yet.** Typecheck is the only static gate.
6. **No OpenAPI generation**; `docs/API.md` is hand-written.
7. **No browser E2E test committed** — the Playwright run was a one-off script, not part of CI.
8. Global search and the AI assistant panel are placeholders clearly labelled "coming" in the UI; they have no functionality.
9. Teams (tables exist) have no API/UI yet.
10. Billing = usage metering only (planned for later phases); not started.

## Phase 2 — Projects, tasks, milestones, dependencies, comments, activity: **COMPLETE (with caveats below)**

### Verified
- `pnpm typecheck` 16/16; `pnpm test` **137 tests pass** (database/RLS 31, api e2e 58, validation 12, web 14, permissions 14, shared 9, worker 8, event-contracts 3, config 3). One uncached run once reported 15/16 tasks with no failing test output I could identify; two later forced runs were 16/16. Not reproduced, so treat as a possible rare flake.
- Real-browser run (Playwright) against live API/DB: create project → add tasks on board → drag a card to another column (persisted after reload) → edit priority/dates/assignee in the drawer → add a dependency → completing a blocked task is refused with a clear message → comment → milestone → list/timeline/activity views → My tasks. No console or page errors. Light, dark and mobile screenshots checked.

### Delivered
- Migration `0003`: projects, milestones, tasks, task_dependencies, comments, activity_events with composite FKs (a task can't point at another workspace's project, a milestone from another project, or an assignee from another org) and RLS by workspace visibility. Activity feed is append-only.
- API: projects, milestones, tasks (per-project numbering, filters, board ordering), dependencies with cycle detection under a per-workspace advisory lock (concurrency-tested), comments (author-only edit), activity feeds, audit entries, outbox events.
- Web: Projects list + create, project page with Board (drag & drop), List, Timeline, Milestones, Activity tabs, search/assignee/milestone filters, task drawer (all fields, dependencies, comments, activity), project settings, My tasks.

### Phase 2 gaps (honest list)
1. Timeline has no dependency arrows (blocked tasks show a lock icon instead); no drag-to-reschedule.
2. Board drag & drop uses native HTML5 drag events: works with a mouse, not on touch screens. Status can still be changed from the list view or task drawer.
3. No calendar view, no subtasks, no file attachments, no @mentions, no rich-text editor in descriptions/comments (plain text).
4. Task permissions follow the org role; there are no per-workspace roles and no per-project membership yet.
5. `task.*` and `project.created` events are written to the outbox but have no consumer yet (notifications arrive in Phase 3).
6. No committed browser E2E test; the Playwright script was a one-off.
7. The Phase 1 gaps above still apply (docker-compose untested, no ESLint, no OpenAPI generation, custom roles).

## Phase 3 — Realtime updates, notifications, background jobs: **COMPLETE (with caveats below)**

### Verified
- `pnpm typecheck` 16/16; `pnpm test --force` 16/16 with **185 tests** (database/RLS 38, api e2e 66, worker 18, web 18, validation 12, permissions 14, shared 9, event-contracts 6, config 3). API suite run repeatedly and stable.
- Real-browser run (Playwright, two separate logged-in users, real API + worker + Redis + Postgres + Next dev server, local SMTP sink): A assigns a task to B → B's bell badge and toast appear **without reload**; A drags the card → B's board moves it live; A comments → B's unread count grows; clicking a notification deep-links to the task; mark-all-read clears the badge; a saved preference persists; assignment email reached the SMTP sink exactly once. No console or page errors. SSE works through the Next.js rewrite proxy in dev. Light, dark, mobile screenshots checked.
- `next build` succeeds.

### Delivered
- Migration `0004`: `notifications` (RLS: own rows, own org only; dedupe key), `notification_preferences`, narrow SECURITY DEFINER job functions (task context, commenters, due-soon, cleanup).
- Events: task.updated/deleted/dependency_changed, project.updated/deleted, milestone.changed now emitted (transactional outbox).
- Worker: notification processor (assigned / commented / status changed; recipients resolved at processing time; delivered under the recipient's RLS context; access re-checked; idempotent), email via check→send→record, scheduled jobs (due/overdue reminders every 15 min, daily cleanup) via BullMQ job schedulers, relay publishes id-only realtime hints to Redis.
- API: notifications list/unread-count/mark-read/read-all, preference GET/PUT, SSE stream `GET /organizations/:orgId/stream` (per-event workspace-visibility check, session + membership re-validated every heartbeat, per-user stream cap, notifications accepted only from the user's private channel).
- Web: bell with unread badge and dropdown, notification center (Inbox / Preferences), live-update hook (batched invalidations, refetch on reconnect, toast on notification).

### Phase 3 gaps (honest list)
1. Reminders use **UTC dates**, not each user's timezone.
2. No job-monitoring UI; failed jobs go to a dead-letter queue but nothing surfaces them.
3. No browser/web-push or mobile push; no digest emails.
4. SSE state is per API process; Redis pub/sub fans events out across processes, but multi-instance behaviour was **not** tested (single API instance only).
5. SSE through a production reverse proxy needs buffering disabled (`X-Accel-Buffering: no` is sent; other proxies not tested). Only the Next dev server proxy was exercised; `next start` was built but not browser-tested.
6. Hints are "something changed" signals: the client refetches, so a burst of activity causes refetches rather than patching state.
7. Notification categories cover tasks only (no mentions, approvals, or AI events yet).
8. Preferences are global per user, not per organization.
9. Browser E2E remains a one-off script, not committed to CI.
10. Earlier gaps still apply: docker-compose untested, no ESLint, no OpenAPI generation, no custom roles, Phase 2 gaps (touch drag & drop, no subtasks/attachments).

## Phase 4a — AI provider layer, documents, knowledge search (RAG): **COMPLETE for 4a (with caveats); Phase 4 as a whole is NOT finished**

Phase 4 is being delivered in parts. **4a (this delivery):** provider abstraction, documents with version history, knowledge indexing, hybrid search, cited AI answers. **Still to do in Phase 4:** meetings (audio upload, transcription, summary/decision/action/blocker extraction with an approval step before anything becomes a task) and AI planning (plan generation, task decomposition).

### Verified
- `pnpm typecheck` 18/18; `pnpm test --force` 18/18 with **223 tests** (api 77, database 49, worker 25, web 19, ai-core 9, validation 12, permissions 14, shared 9, event-contracts 6, config 3). `next build` succeeds.
- Real-browser run (Playwright) against live API + worker + Redis + Postgres: Alice writes and saves a document in the editor → the worker indexes it → keyword search finds it → "Ask AI" answers with a `[1]` citation and a source card → Bob (a member of a different workspace) gets no search results and no sources, and a direct API read returns 404 → version history, preview and restore (restored content is shown, new version created) → a second tab saving makes the first tab's unsaved editor show a stale-edit warning (live) → top-bar search → deleting the document removes it from search and its chunks from the index. No console or page errors.
- The browser run found and fixed two real bugs: a document consisting only of headings produced no searchable chunks, and the editor kept showing old content after restoring a version.

### Delivered
- `@teamos/ai-core`: provider interface (chat + embeddings), OpenAI-compatible provider (error classification for retry, timeouts, key never logged), offline `LocalProvider`, heading-aware chunker, HTML-to-text.
- Migration `0005`: `documents`, immutable `document_versions`, `knowledge_chunks` (org/workspace/source/model/version metadata, `tsvector`, `real[]` embedding), `ai_usage`, `cosine_sim()`, `knowledge_search()` (keyword + vector fused with reciprocal-rank fusion), `job_document_state()`.
- Authorization at query time: search runs under the caller's RLS context, so it uses their CURRENT workspace access (revoked access and soft-deleted documents disappear immediately, even before the indexer runs). Chunk metadata is never used to decide access.
- Worker: knowledge indexer (idempotent, ignores stale events, deletion propagation, rethrows provider failures for retry, never indexes across tenants), usage metering.
- API: documents CRUD, version list/preview/restore (restore appends a new version), optimistic concurrency (409 on stale save), server-side HTML sanitising, `POST /knowledge/search`, `POST /knowledge/ask` (read-only; citations validated against the sources actually supplied; model not called when nothing relevant is found; per-user hourly limits; 503 when the provider is down).
- Web: Documents list, Tiptap editor with version history/preview/restore/delete and stale-edit warning, Knowledge search page (search + Ask AI with linked citations), working top-bar search, live refresh of document lists.

### Phase 4a gaps (honest list)
1. **No real AI model was exercised.** The sandbox has no API key. The default `local` provider uses hashed bag-of-words "embeddings" (lexical overlap only, not semantic) and a scripted answerer that quotes the matching passages; the UI says so. The OpenAI-compatible provider is only tested against mocked HTTP responses, never the real service. Answer quality, prompt behaviour and real semantic search are therefore **unverified**.
2. **pgvector is not used** (the extension could not be installed here). Vectors are `real[]` with brute-force cosine in SQL over the chunks the caller can see — correct and tested, but O(chunks); no ANN index. Moving to pgvector + HNSW is a migration plus a query change and is **untested**.
3. **No reranking step** (fusion is reciprocal-rank only). Hybrid retrieval + permission filtering + context assembly are done.
4. **Changing the embedding model does not re-index automatically.** Search only compares vectors from the current model/version, so old chunks fall back to keyword matching until re-indexed; there is no re-index job yet.
5. Only **documents** are indexed. Tasks, projects, comments and meetings are not (the `MEETING` source type is reserved).
6. No document attachments, no per-document permissions (access = workspace visibility + role), no real-time co-editing (stale-save detection only), no project linking UI (the API supports `projectId`).
7. Prompt-injection protection is prompt-level (sources delimited and marked untrusted, invented citations stripped). It reduces risk; it is not a guarantee. The AI here is read-only and cannot change data.
8. The API e2e tests use a small stand-in for the indexer (the API package cannot import the worker); the real indexer has its own tests.
9. Earlier gaps still apply (docker-compose untested, no ESLint, no OpenAPI generation, no custom roles, committed browser E2E missing, UTC-only reminders).

## Phase 4b — Meetings, extraction with approval, AI planning: **COMPLETE (with caveats); Phase 4 is now fully delivered**

### Verified
- `pnpm typecheck` 18/18; `pnpm test --force` all green with **256 tests** (api 85, database 55, worker 34, web 20, ai-core 12, validation 12, permissions 14, shared 9, event-contracts 6, config 3).
- Real-browser run (Playwright, live API + worker + Redis + Postgres): create a meeting with a pasted transcript → "Process meeting" → the worker extracts and the page flips to *Ready for review* live → 4 items shown (1 decision, 2 action items, 1 blocker) with **zero tasks existing** → approving an action item (choosing a project) creates exactly one task; rejecting an action item and acknowledging a decision create none → a user in another workspace sees no meetings → "Plan with AI" proposes 3 tasks, none exist until "Create tasks" is pressed, then exactly 3 are created. No console/page errors.

### Delivered
- Migration `0006`: `meetings`, `meeting_items` (decided items are immutable; a task link is only allowed on an approved action item), workspace-scoped RLS plus worker-only system policies, `knowledge_search` now also covers READY meetings, `job_meeting_state()`.
- Worker meeting processor: transcription (OpenAI-compatible `/audio/transcriptions`) when audio is present, structured extraction validated with zod, replaces only PENDING items, indexes transcripts for search, idempotent on retry, marks FAILED with a readable reason, retries transient provider errors only.
- API: meetings CRUD (soft delete), raw audio upload (`PUT …/audio`, mp3/wav/m4a/webm/ogg, ≤25 MB, stored atomically), `process`, item edit / approve / reject. **Approving an action item creates the task in the same transaction** (single-use, race-safe: 3 concurrent approvals create one task). `POST /projects/:id/plan` is read-only; `POST /projects/:id/plan/apply` creates the reviewed tasks and dependencies atomically (dependencies can only point at earlier tasks, so no cycles).
- Web: Meetings list/detail (source, status, summary, item review with edit / project / assignee / priority / approve / reject), "Plan with AI" dialog on projects, live refresh on `meeting.*` events.
- Permissions: create/process/upload need `meeting:manage` (Project Manager+); reading needs `document:read`; deciding needs `approval:decide`; planning needs `ai:use` (+ `task:create` to apply).

### Phase 4b gaps (honest list)
1. **Real Whisper and a real LLM were never exercised** (no API key here). Extraction in the offline provider is rule-based: it only understands explicit `Decision:` / `Action:` / `Blocker:` lines and bullet lists, not free conversation. Real-model quality, JSON compliance and transcription accuracy are unverified.
2. **Audio is stored on local disk** (`STORAGE_DIR`) shared by API and worker: single host only. No S3/MinIO yet.
3. **No speaker diarization**; speaker names exist only if they are written in the transcript text. Transcripts are truncated to 60k characters for the model. No PDF/other source formats; no live recording in the browser.
4. Assignee names from the transcript are shown as a *hint*; a person picks the real assignee. Due dates/priorities are AI suggestions that the reviewer can change.
5. Prompt-injection protection is prompt-level plus schema validation and mandatory human approval; it is not a guarantee.
6. The API e2e tests simulate the worker (items are inserted directly); the worker's own tests cover the processor.
7. Earlier gaps still apply: no pgvector, no reranking, no automatic re-index on model change, only documents and meetings indexed, docker-compose untested, no ESLint, no OpenAPI generation, no custom roles, no committed browser E2E, UTC-only reminders.

## Phase 5 — Risk detection, agents, approval workflow: **COMPLETE (with caveats)**

### Verified
- `pnpm typecheck` 18/18; `pnpm test --force` all green with **275 tests** (api 97, database 61, worker 35, web 21, shared 14, permissions 14, ai-core 12, validation 12, event-contracts 6, config 3). `next build` succeeds.
- Real-browser run (Playwright, live API + worker + Redis + Postgres): Risk center shows an overdue task (Fact) and downstream slip (Inferred) → "Propose fixes" creates 3 PENDING proposals and **no task changes** → a second user's already-open Approval center updates live and shows no approve/reject controls (Developer) → approving moves a downstream due date by the computed 5-day slip → rejecting changes nothing → editing a task after it was proposed makes its approval come back "Out of date" and applies nothing → 8 `agent_action.*` audit rows. No console/page errors.
- The spec's critical scenarios are covered by tests: unauthorized users cannot approve; rejected actions cannot execute; an action cannot execute twice (incl. 3 concurrent approvals → one execution); a changed target version invalidates the approval; failed executions roll back, are recorded and are retryable; expired proposals cannot be approved; tenant/workspace isolation; every executed mutation is audited with the approval reference.

### Delivered
- **Risk engine** (`@teamos/shared`, pure and deterministic, no model): overdue tasks, slip propagated through dependencies, due dates that contradict a dependency, unassigned work due soon, projected project-deadline overrun. Every finding is labelled **Fact** or **Inferred** and carries a recommendation. `GET /risks`, `GET /projects/:id/risks`.
- **Agents**: Dependency Risk Agent (proposes moving downstream due dates by the computed slip) and Task Management Agent (proposes owners for unassigned work by lowest open workload). They read data only through a typed `AgentToolbox` (permission-checked, run under the user's RLS, no raw DB, no ids from the model) and can only create PENDING proposals.
- **Approval workflow** (`agent_actions`, migration 0007): before/after, evidence, rationale, 7-day expiry (worker sweep every 10 min, also checked at approval), statuses PENDING → APPROVED → EXECUTING → EXECUTED | FAILED | STALE, REJECTED, EXPIRED. The DB makes proposals immutable and enforces the state machine; approvals are bound to a SHA-256 of action type + target + exact payload, re-verified before execution.
- **Execution**: approve records the decision then applies the change in ONE transaction under the approver's authority (permission re-checked, target re-read and version-compared, applied through the normal task rules, marked EXECUTED). Any error rolls the change back and records FAILED; `retry` re-validates from scratch (max 3 attempts).
- **Audit**: `agent_action.proposed` (actor AI, with requesting user), `.approved/.rejected/.executed/.failed/.stale` (actor = the approver, with approval id, proposer, payload).
- Web: Risk center, Approval center (before/after, evidence, notes, approve/reject/retry, status tabs), live refresh via `agent.action.*` hints. Permissions: propose needs `ai:use`; read needs `approval:read`; decide needs `approval:decide` (Project Manager+).

### Phase 5 gaps (honest list)
1. Only **two action types** exist (change a task's due date, assign a task). Not yet implemented: project status changes, creating proposed tasks via agents (the Phase 4 flows already require human review), external comments/messages (Phase 6). The Meeting Intelligence, Project Planning, Knowledge Search, Reporting and GitHub agents are not separate orchestrated agents; planning and meetings keep their own human-review flows.
2. **No LLM is involved in risk analysis or proposals** — they are deterministic rules. That is predictable and testable, but there is no natural-language "explain the impact" or conversational "a backend delay was reported" intake yet.
3. Risks are computed on demand from current data (no stored history, no scheduled risk scans, no risk notifications). Dates use UTC.
4. **No bell/email notification for new approvals** (only live refresh of an open Approval center). Notification categories would need a migration.
5. Approving two proposals for the same task makes the second one "Out of date" (by design: the first changed the version); ask the agent to propose again.
6. Slip model is simple (days of lateness propagate unchanged; no working-day calendars, durations or capacity); workload suggestions count open tasks only.
7. Execution runs in the approver's API request (not a queue), so a crash between approval and execution leaves the action APPROVED until someone retries; the UI shows no "retry" for that case yet.
8. Earlier gaps still apply (no real LLM/Whisper tested, no pgvector, docker-compose untested, no ESLint, no OpenAPI generation, no custom roles, no committed browser E2E, local-disk audio storage).

## Phase 6a — GitHub integration: **COMPLETE for GitHub (with caveats); Phase 6 as a whole is NOT finished (Google Calendar and email are Phase 6b)**

### Verified
- `pnpm typecheck` 20/20; `pnpm test --force` all green with **321 tests** (api 112, database 69, worker 48, web 22, shared 14, permissions 14, ai-core 12, validation 12, integrations 9, event-contracts 6, config 3). `next build` succeeds.
- Real-browser run (Playwright, live API + worker + Redis + Postgres) against a **local mock GitHub server** (OAuth, REST, hooks): Developer sees the page with no connect controls → Admin completes the OAuth round trip → token is AES-GCM ciphertext in the DB and never in the page → connecting a repo creates a webhook → the worker syncs a PR whose title contains a task key and auto-links it → the task drawer lists it → a bad signature gets 401, a signed delivery marks the PR merged, a redelivery is deduplicated → disconnect deletes the token, removes the webhook and later deliveries get 404. No console errors.
- **Not tested against github.com.** Everything above ran against a stand-in that implements only the endpoints we call; real GitHub behaviour (pagination quirks, rate limits, scope prompts, redirect URIs, webhook delivery from the internet) is unverified.

### Delivered
- **Token vault** (`@teamos/integrations`): AES-256-GCM, key from `INTEGRATION_ENCRYPTION_KEY`, each ciphertext bound (AAD) to its own row. Tokens live in `integration_tokens`, readable only by the background (system) context, never returned by any endpoint.
- **OAuth**: single-use hashed `state` bound to the starting user and organization, 10-minute expiry; the callback re-checks `integration:manage`; organization comes from the server-side state, never the URL. Scopes `repo admin:repo_hook`.
- **Repositories**: a repo belongs to exactly one workspace (optionally one project); synced items inherit that workspace's visibility (RLS). Connecting creates a webhook with a per-repo random secret (stored encrypted); failure to store rolls the GitHub hook back.
- **Sync**: worker job on connect, on "Sync now" (rate limited) and every 15 min; incremental with a cursor and 5-minute overlap; idempotent upserts. PRs, issues and commits are stored as title/state/url/author only (no bodies).
- **Webhooks**: public endpoint, HMAC-SHA256 over the exact raw body, constant-time compare, mandatory delivery/event headers, uniform 404 for unknown/disconnected repos, per-(repo, delivery) idempotency, processing asynchronous via the outbox.
- **Task linking**: PRs/issues/commits that mention a task key (e.g. `APO-12`) auto-link, only within the repo's workspace (and project if set); manual link/unlink via API; shown in the task drawer.
- **Disconnect**: the integration is flipped to DISCONNECTED (and repos deactivated) in one transaction first, so sync and webhooks stop at commit; a sync racing with disconnect re-checks under a row lock and loses. Then webhooks are removed on GitHub (best effort) and the token deleted. A revoked token marks the integration ERROR (no retry storm); retryable GitHub errors use BullMQ retries.
- **Audit**: `integration.connected/disconnected/repo_connected/repo_disconnected`, `task_link.created/deleted`. Realtime hints for `integration.*` and `github.pull_request.updated`.
- Without `INTEGRATION_ENCRYPTION_KEY` + GitHub credentials the API reports `configured:false`, the UI says so, and the worker logs "integrations disabled".

### Phase 6a gaps (honest list)
1. Google Calendar and email were built in Phase 6b (below).
2. The OAuth App scope `repo` is coarse (read/write on private repos). A **GitHub App** with read-only permissions is the better production choice; not implemented.
3. Webhooks require `API_URL` to be reachable from the internet; locally GitHub cannot deliver, so only the 15-minute/manual sync works.
4. No automation from GitHub to task status (a merged PR does not move a task) and no PR creation from TeamOS; linking is informational. Manual linking has an API but **no UI** yet.
5. Sync is bounded (5 pages of 100 for PRs/issues, 1 page of commits per run); very busy repos can lag until webhooks catch up. Commits arrive mainly via push webhooks.
6. A repo that was connected, disconnected and reconnected is refused (history is kept); reconnecting is not supported yet.
7. One GitHub connection per organization; no per-user tokens; no token refresh (OAuth App tokens do not expire, but can be revoked → ERROR → Reconnect).
8. Earlier gaps still apply (no real LLM/Whisper tested, no pgvector, docker-compose untested, no ESLint, no OpenAPI generation, no custom roles, no committed browser E2E, local-disk audio storage, only two agent action types).


## Phase 6b — Google Calendar + Gmail: **COMPLETE against a mock Google server only; Phase 6 is now fully built but NOT verified against real Google**

### Verified
- `pnpm typecheck` 20/20; `pnpm test --force` all green: api 132, database 79, worker 68, web 23, integrations 20, shared 14, permissions 14, ai-core 12, validation 12, event-contracts 6, config 3 (**383 tests**). `next build` succeeds.
- Real-browser run (Playwright, live API + worker + Redis + Postgres) against a **local mock Google** (OAuth, token, revoke, Calendar v3, Gmail v1): Admin OAuth round trip for Calendar (scope `calendar.readonly` only) → tokens stored as ciphertext, never in the page → calendar connected to a workspace → worker syncs events → Calendar page flags overlapping events → a meeting is linked to an event (sets the meeting date) → incremental sync (sync token) applies a cancellation and an edit → Developer sees events with no link controls. Gmail: OAuth, label connected with a default project → worker ingests a labelled message, links it to the project by task key, the AI **proposes** a decision and an action item (no task is created) → Admin approves the action item and exactly one task is created; approving a decision creates none → Developer can read but not approve → disconnect deletes the token, revokes the grant at Google, deactivates the mailbox, and later mail is never read. No console errors. (A bad `pattern` attribute on the label input was found by this run and fixed.)

### Delivered
- Providers `GOOGLE_CALENDAR` and `GOOGLE_MAIL` are separate integrations with minimal read-only scopes, offline access, same AES-GCM vault and single-use OAuth state as GitHub. The callback refuses a missing scope or a missing refresh token. Access tokens refresh 60 s before expiry; a revoked refresh token sets ERROR (no retry storm).
- Calendar: incremental `syncToken` sync, 410 → full resync, full listing removes vanished events, window −14d/+90d; stores title/time/attendee count only; 1:1 meeting link; overlap flag.
- Gmail: only messages with the configured label; ≤4000-char excerpt (quotes/signature stripped); project via task key else mailbox default; AI proposals need `approval:decide`; approved action items create tasks in the same transaction; decided items are immutable (trigger).
- Disconnect stops syncing in the same transaction that flips the status; workers re-check under a row lock. Audit: `integration.calendar_connected`, `integration.mailbox_connected`, `meeting.calendar_linked/unlinked`, `email.linked/unlinked/item_approved/item_rejected`. Realtime hints for `calendar.synced`, `email.processed`.
- Migration `0009_google.sql` with RLS and column grants.

### Phase 6b gaps (honest list)
1. **Never run against real Google** — only the mock. Redirect URIs, consent screens and quota behaviour are unverified.
2. `gmail.readonly` is a Google *restricted* scope: production use needs OAuth app verification and a security assessment.
3. Connections are organization-level (admin-connected), not per user.
4. Only label-filtered mail is ingested, and only excerpts are stored. No reprocess for FAILED messages.
5. Read-only: no event creation in Google. Polling every 15 min; no Google push (watch) notifications.
6. Token-refresh logic is duplicated between API and worker.
7. Reconnecting a previously disconnected calendar source with history is refused.
8. No web unit tests for the Calendar/Email pages (covered only by the manual browser run, which is not committed).
9. Earlier gaps still apply (no real LLM/Whisper/GitHub tested, no pgvector, docker-compose untested, no ESLint, no OpenAPI generation, no custom roles, UTC-only reminders, local-disk audio storage, no bell/email notification for approvals, only two agent action types, coarse GitHub `repo` scope, webhooks need a public API_URL).

## Next: Phase 7 — security hardening, performance, monitoring, production deploy (awaiting go-ahead).

## Phase 7 — Hardening, performance, monitoring, deployment: **BUILT; images/compose NOT executed (no Docker here)**

### Verified
- `pnpm typecheck` 20/20; `pnpm test --force` all green with **424 tests** (api 147, database 84, worker 78, web 23, integrations 20, config 14, shared 14, permissions 14, ai-core 12, validation 12, event-contracts 6). `next build` (standalone) succeeds.
- Browser regression (Playwright, live stack incl. mock GitHub/Google) re-run **after** the RLS rewrite and dependency upgrades: GitHub flow and Google Calendar/Gmail flow both pass, no console errors.
- Production bundles booted by hand: `pnpm deploy --prod` folders for api and worker run `node dist/main.js` and answer `/health/ready`; Next standalone serves CSP/HSTS and renders login/register with 0 CSP violations; `NODE_ENV=production` with unsafe settings refuses to start and lists why.
- Backup → restore round trip proven with `scripts/ops/backup.sh` + `restore-check.sh` (38 RLS tables, 12 migrations after restore).

### Delivered (details: ARCHITECTURE §20, SECURITY.md, PERFORMANCE.md, DEPLOYMENT.md)
- **Security**: production config guard; route-authorization inventory test; web CSP/HSTS/Permissions-Policy; SMTP auth + mandatory STARTTLS in production; dependency audit **55 → 6** findings; SECURITY.md control matrix.
- **Performance**: load-tested on 300k tasks. Found and fixed a per-row RLS function call (>10 s → 0.2 s), task-create lock contention (p50 1.1 s → 83 ms), unbounded task list (now capped at 2000 with `meta.total`), "my tasks" (497 → 85 ms). Migrations 0010–0012.
- **Monitoring**: `/health/live`, `/health/ready`, token-protected Prometheus `/metrics` for API and worker (queue depth, job outcomes, outbox backlog/lag), JSON access logs, `X-Request-Id`.
- **Deployment**: multi-target Dockerfile, `docker-compose.prod.yml`, Caddy config, role-init script, `.env.production.example` (placeholders only), backup/restore scripts, CI image-build job, runbook with alert suggestions.
- **Bug found by building for production**: compiled API crashed on boot (`./express.d`); dev and tests never ran the compiled output. Fixed.

### Phase 7 gaps (honest list)
1. **Docker images and compose were never built or run** (no daemon here). The first CI run of the `images` job / a staging deploy is the real test.
2. Load numbers come from one shared sandbox machine; not capacity figures. No soak, chaos or horizontal-scale test; the worker was not load-tested.
3. **Knowledge search is still brute-force cosine** (O(chunks); ~0.4 s at 20k chunks). pgvector + HNSW was not available in the sandbox and is untested.
4. ~~6 dependency advisories~~ **Resolved** in the major-upgrade pass below (audit: 0 known).
5. Task search (`ILIKE`) is a filtered scan under RLS (~0.4 s at 400k tasks); project/task counts are computed on read.
6. No Sentry/OpenTelemetry; `SENTRY_DSN` is unused. Alert thresholds are untuned suggestions.
7. Meeting audio is on a local volume → API and worker must share a host; no object storage adapter. No `INTEGRATION_ENCRYPTION_KEY` rotation.
8. CSP keeps `script-src 'unsafe-inline'` (no nonces). No MFA/SSO, no independent penetration test, no WAF.
9. `audit_logs` have no retention/archival policy; single-instance Postgres/Redis in the bundled compose.
10. All earlier gaps still apply: nothing was tested against real GitHub, real Google (and `gmail.readonly` needs Google verification), a real LLM/Whisper or a real SMTP relay; no custom roles; no committed browser E2E; no ESLint; no OpenAPI generation; UTC-only reminders; only two agent action types.

## Test-readiness pass (after Phase 7)

### Verified
- `pnpm lint` clean (ESLint 9 flat config, typescript-eslint incl. `no-floating-promises`, react-hooks); `pnpm typecheck` 20/20; `pnpm test --force` **441 tests** (api 148, database 84, worker 78, web 38, integrations 20, config 15, shared 14, permissions 14, ai-core 12, validation 12, event-contracts 6); `next build` OK.
- **Browser E2E is now committed** (`e2e/`): 8 Playwright specs (auth/org, projects/tasks, notifications/realtime, documents/knowledge/meetings, AI plan/risk/agents, approvals, GitHub, Google Calendar + Gmail), mock GitHub/Google/SMTP servers, `e2e/stack.sh` and `e2e/run.sh`. Run locally against the **production** web build + compiled API/worker: all 8 pass, exit 0.
- New web component tests for the Calendar and Email pages (permission gating, project-required rule for action items, overlap badge, safe links).
- `docs/ROUTES.md`: generated route/permission index with a test that fails when it is stale (not OpenAPI).

### Changes this pass
- `RATE_LIMIT_MULTIPLIER` (test stacks only; production refuses anything but 1) so E2E can register dozens of users from one IP.
- Web: `ALLOW_HTTP=1` build flag drops HSTS/`upgrade-insecure-requests` for the plain-http E2E (never for deployment).
- E2E specs poll for outbox tokens instead of sleeping (found a timing flake).

### Gaps in this pass (honest list)
1. The CI `e2e` and `images` jobs were written but **never executed** (no GitHub Actions or Docker here). The same commands were run by hand.
2. Test files are excluded from package tsconfigs, so they are **not type-checked or linted** (vitest transpiles them).
3. No OpenAPI document (only `docs/ROUTES.md` + `docs/API.md`); no component tests for pages other than Calendar/Email; E2E screenshots are not asserted visually.
4. E2E specs are plain scripts with their own `console.log` checks, not a test runner with reports/retries.
5. Everything listed under Phase 7 gaps still applies.

## Major dependency upgrades (after the test-readiness pass)
NestJS 10→11 (Express 5), zod 3→4, Tiptap 2→3. `pnpm audit --prod`: **0 known vulnerabilities**. Verified: typecheck 20/20, lint clean, **441 tests** pass unchanged, `next build` OK, and all 8 browser E2E specs pass on the production build. Code changes: `ZodPipe`/`parseModelJson` type signatures, Tiptap `setContent` options, StarterKit's bundled Link disabled in favour of our configured one.
Not re-verified: the compiled Docker images (never built), and behaviours only a real browser session with rich-text editing over time would reveal (the E2E edits a document but is not an exhaustive editor test).

## Project status
All seven phases are implemented to the level described above. **It is not production-ready until:** the images build and run on a staging host, the integrations are exercised against the real providers, a real LLM/Whisper/SMTP relay is configured and tested, and the open items in SECURITY.md and PERFORMANCE.md are accepted or fixed.
