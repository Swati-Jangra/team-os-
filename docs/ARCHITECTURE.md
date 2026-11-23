# TeamOS AI — Architecture & Phase 1 Plan (for review)

Status: DRAFT v1 — awaiting approval before any code is generated.

---

## 0. Major decisions and why

| # | Decision | Rationale | Trade-off |
|---|----------|-----------|-----------|
| D1 | Modular monolith (NestJS) + separate worker app | One deployable API, clear module seams, easy to split later | Needs discipline to keep module boundaries |
| D2 | PostgreSQL RLS **plus** application-level authorization | Defense in depth against cross-tenant leaks | Every request must set tenant context in a transaction |
| D3 | **Revised in Phase 1:** Kysely (typed query builder, CamelCasePlugin) + hand-written SQL migrations (`packages/database/migrations/NNNN_*.sql`). Originally Prisma. | Prisma's engine binaries could not be downloaded in the build sandbox (binaries.prisma.sh → 403), so `generate`/`migrate` were impossible. Kysely also fits RLS/pgvector/outbox SQL better. Approved by the user. | Types in `packages/database/src/types.ts` are hand-maintained, not generated; no ORM-level migrations diffing |
| D4 | Transactional outbox → BullMQ | No dual-write bugs between DB and queue | Small publish latency (poller, ~200ms) |
| D5 | Deterministic scheduler (CPM, topological sort) in `packages/shared` | Spec forbids LLM math; testable | Must implement 4 dependency types + lag carefully |
| D6 | AI provider abstraction (`ai-core`) with Zod-validated structured output | Interchangeable OpenAI/Anthropic | Lowest-common-denominator features; adapters for tool calling |
| D7 | Agents never touch DB; only typed tools that call the same application services as the UI | Single authorization path | Tools must be maintained alongside services |
| D8 | Approvals bound to payload hash + target version, revalidated at execution | Prevents stale/tampered actions | Extra version columns on targetable entities |
| D9 | Sessions: opaque server-side session tokens in httpOnly cookies (not JWT) | Revocable, simple CSRF story | Session lookup per request (Redis-cached) |
| D10 | Realtime: persist → outbox → Socket.IO via Redis adapter | Never broadcast uncommitted state | Slight delay vs. direct emit |

### Technical risks
1. **RLS + connection pooling** — session variables leak across pooled connections. Mitigation: `SET LOCAL` inside an interactive transaction per request; never plain `SET`; integration test that proves isolation under concurrency.
2. **Scope size** — 32 pages, 40 models. Mitigation: strict phases; each phase shippable and tested.
3. **Prompt injection via documents/meetings/emails** — Mitigation: treat retrieved content as data, tools re-check permissions, approval gate for all business-critical mutations.
4. **Vector search authorization** — Mitigation: vector hit → re-check permission against live DB before returning.
5. **Performance targets** (100k objects, <1s p95 search) — Mitigation: HNSW index, hybrid RRF, load test in Phase 7.
6. **Transcription provider choice** unspecified — Open question Q2 below.

### Open questions for you
- Q1: Auth — build credentials auth ourselves (planned), or use an auth library/provider?
- Q2: Transcription provider (OpenAI Whisper assumed)?
- Q3: Email provider for transactional mail (Resend / SES / SMTP)? Dev default: Mailpit in Docker.
- Q4: Document editor — Tiptap (assumed) with Yjs deferred; v1 = single-writer with version history.
- Q5: Billing (page 32) — usage metering only, or Stripe integration? Assumed metering only.

---

## 1. Monorepo structure

```
team-os-ai/
  apps/
    web/                      Next.js (App Router)
      src/app/(auth)/ (app)/  route groups
      src/features/<feature>/ components, hooks, api, schemas per feature
      src/lib/                api client, socket client, query client
    api/                      NestJS
      src/modules/<feature>/  controller, service, repository, dto, events, tests
      src/common/             guards, interceptors, filters, request-context
      src/realtime/           Socket.IO gateways
    worker/                   BullMQ processors + outbox relay + schedulers
  packages/
    database/                 Kysely client + types, SQL migrations (schema + RLS), tenant-context helper `withContext`
    shared/                   scheduling engine, graph algorithms, utils, error codes
    validation/               Zod schemas = API contracts (used by web + api)
    ui/                       shadcn-based design system + tokens
    ai-core/                  provider interface, prompts, structured output, RAG pipeline
    agent-tools/              typed tools + agent definitions + guardrails
    event-contracts/          versioned event schemas
    permissions/              role→permission matrix, policy functions
    config/                   eslint, tsconfig, tailwind presets, env schema
  infrastructure/ docker/ deployment/ monitoring/
  docs/ architecture/ database/ api/ security/
```

## 2. Module dependency rules

```
web ──► validation, ui, shared, permissions(types), event-contracts(types)
api ──► database, validation, shared, permissions, event-contracts, ai-core, agent-tools
worker ─► database, shared, event-contracts, ai-core, agent-tools
agent-tools ─► permissions, validation, (service interfaces injected, no direct DB)
ai-core ─► validation, shared          (no DB, no Nest)
permissions, validation, shared, event-contracts ─► (leaf packages, no workspace deps)
database ─► (leaf)
```
Rules: leaf packages never import upward; no cycles (enforced with `dependency-cruiser` in CI); within `api`, modules talk through exported service interfaces only, never other modules' repositories.

## 3. Database ER (core relationships)

```
User ─< OrganizationMember >─ Organization ─< Workspace ─< WorkspaceMember >─ User
Organization ─< Team ─< TeamMember
Organization ─< Role ─< RolePermission >─ Permission
Workspace ─< Project ─< ProjectMember
Project ─< Milestone
Project ─< Task ─< Task (parent/subtasks)
Task ─< TaskAssignee >─ User
Task ─< TaskDependency >─ Task     (type: FS|SS|FF|SF, lagMinutes)
Task ─< TaskLabel >─ Label
Task|Document|Meeting ─< Comment ─< Mention
Workspace ─< Meeting ─1 Transcript ; Meeting ─< Decision ; Meeting ─< ActionItem ─(approved)─► Task
Workspace ─< Document ─< DocumentVersion ; Attachment (polymorphic via sourceType/sourceId, FK-checked in service)
Workspace ─< KnowledgeChunk ─1 Embedding
Workspace ─< AIRun ─< AIMessage ; AIRun ─< AgentAction ─1 AgentApproval ; AgentAction ─< AgentExecution
Organization ─< Integration ─< IntegrationToken ; Integration ─< WebhookEvent
User ─< Notification ; User ─< NotificationPreference
Organization ─< AuditLog (append-only) ; OutboxEvent (global, tenant-tagged)
```

### Tenant ownership path rule
Every tenant table carries `organization_id` (and `workspace_id` where applicable). Composite FKs `(workspace_id, id)` ensure a child cannot point to a parent in another workspace. RLS policy on every tenant table: `organization_id = current_setting('app.org_id')::uuid`, and workspace-scoped tables additionally check membership via `app.user_id`.

## 4. Database schema plan (originally written for Prisma; implemented as SQL migrations — see D3)
- UUID v7 PKs (`@default(dbgenerated("gen_random_uuid()"))` initially; v7 optional later).
- `createdAt`, `updatedAt`, `deletedAt` (soft delete on User, Org, Workspace, Project, Task, Document, Comment; **not** on AuditLog/Outbox/Execution).
- `version Int` on Task, Project, Milestone, Document (optimistic concurrency + approval binding).
- Unique: `(organizationId, userId)` membership, `(workspaceId, projectKey)`, `(taskId, dependsOnTaskId, type)`.
- Check constraint: no self-dependency. Cycle prevention in service within a serializable transaction (+ advisory lock per project).
- Raw SQL migrations (checked into `packages/database/prisma/migrations`): `CREATE EXTENSION vector`, RLS policies, HNSW index on `embedding`, GIN tsvector index on chunk content, revoke UPDATE/DELETE on `audit_logs` from app role, partial indexes on `deleted_at IS NULL`.
- Two DB roles: `app_user` (RLS enforced, no BYPASSRLS) and `migrator`. Worker uses `app_user` with explicit tenant context per job.
- Models by phase: P1: User, Session, Org, OrgMember, Workspace, WorkspaceMember, Team, Role, Permission, RolePermission, AuditLog, OutboxEvent, Invitation, EmailToken. P2: Project…Activity, Label. P3: Notification*. P4: Meeting…, Document…, KnowledgeChunk, Embedding, AIRun, AIMessage. P5: AgentAction/Approval/Execution. P6: Integration*, WebhookEvent.

## 5. API specification (summary; full OpenAPI generated from Zod via `nestjs-zod`)
Base `/api/v1`. Envelope: `{ data, meta?: {page, pageSize, total, cursor} }`; errors `{ error: { code, message, details?, requestId } }`. Pagination: cursor for feeds, page/pageSize for tables. Header `X-Request-Id` on all responses.

| Area | Endpoints |
|------|-----------|
| Auth | POST /auth/register, /login, /logout, /verify-email, /forgot-password, /reset-password; GET /auth/me; GET/DELETE /auth/sessions |
| Orgs | POST/GET /organizations; GET/PATCH /organizations/:orgId; members, invitations CRUD; POST /invitations/:token/accept |
| Workspaces | POST/GET /organizations/:orgId/workspaces; GET/PATCH/DELETE /workspaces/:id; members; teams |
| Roles | GET /roles; POST/PATCH custom roles; PUT /members/:id/role |
| Projects | CRUD /workspaces/:ws/projects; members; milestones; GET /projects/:id/timeline, /health |
| Tasks | CRUD /projects/:id/tasks; assignees; labels; subtasks; time entries; history; attachments |
| Dependencies | POST/DELETE /tasks/:id/dependencies; GET /projects/:id/graph, /critical-path; POST /projects/:id/schedule/recalculate (dry-run + apply) |
| Comments | CRUD on `/{task|document|meeting}/:id/comments` |
| Meetings | CRUD; POST /meetings/:id/audio (signed upload URL); GET transcript; POST /meetings/:id/process; action items review endpoints |
| Documents | CRUD; versions; restore; attachments |
| Search | POST /workspaces/:ws/search (hybrid), POST /workspaces/:ws/ask (RAG answer + sources) |
| AI | POST /ai/plan (async → run id), GET /ai/runs/:id, /ai/risk-analysis, /ai/duplicates, /ai/reports |
| Agents | POST /agents/:name/runs; GET /agent-actions |
| Approvals | GET /approvals; GET /approvals/:id (diff); POST /:id/approve, /:id/reject; GET executions |
| Integrations | GET /integrations; POST /integrations/:provider/connect; callback; DELETE; POST /webhooks/:provider |
| Notifications | GET; POST /read; GET/PUT /notification-preferences |
| Audit | GET /audit-logs (filters, export) |

Rate limiting: Redis-backed token bucket, stricter on auth and AI endpoints. Idempotency-Key header on POST mutations that create resources or trigger AI.

## 6. Authentication and RBAC
- Passwords: argon2id. Email verification and reset via single-use hashed tokens with expiry.
- Sessions: random 256-bit token, stored hashed in `sessions` (+ Redis cache), httpOnly + Secure + SameSite=Lax cookie. CSRF: double-submit token for state-changing requests from browser. Session list/revoke, rotation on login/privilege change.
- Brute-force protection: per-IP and per-email rate limits, progressive delay.
- **Tenant context:** `RequestContextGuard` resolves user → org → workspace membership server-side from path + DB (never trusting body/headers), sets `AsyncLocalStorage` context, and `withContext()` runs `set_config('app.user_id'|'app.org_id'|'app.workspace_id', …, true)` (transaction-local) per transaction.
- **RBAC:** `permissions` package defines `resource:action` strings (e.g. `task:update`, `approval:decide`). Default role matrix for Owner, Admin, Project Manager, Team Lead, Developer, Viewer, Guest; org-level custom roles stored in `Role/RolePermission`.
- **Resource-level:** policy functions `can(user, action, resource)` handle ownership/assignee/project-membership/document ACL; Guest limited to explicitly shared resources. Decorator `@RequirePermission()` + service-level `policy.assert()` (controllers never the only check).
- Last-owner protection, no self-escalation, permission changes audited.

## 7. AI orchestration design
- `ai-core`: `LLMProvider` interface {`generateObject(schema, messages)`, `generateText`, `stream`, `callTools`, `embed`}; adapters for OpenAI and Anthropic; retries, timeouts, token/cost accounting into `AIRun`; model routing by task via config.
- **Services** (10 in spec) each = prompt template + Zod output schema + deterministic pre/post-processing. Outputs carry `{facts[], inferences[], recommendations[], sources[]}` — facts must reference source IDs; the validator rejects facts without a source.
- **Agents** (7): each defines allowed tools, system prompt, max steps, token budget. Orchestrator runs loop, persists every message/tool call to `AIRun/AIMessage`.
- **Tools:** each = `{name, inputSchema, risk: 'read'|'propose', handler}`. Handler receives a `ToolContext {userId, orgId, workspaceId}` derived from the *initiating user's session* (not model output). Read tools call application services (same policy checks as UI). "Propose" tools only write an `AgentAction` row (payload + target version) — never mutate business data.
- **Injection defenses:** retrieved text wrapped as untrusted data blocks; tool args validated by Zod and re-authorized; no tool takes raw SQL/URLs; outbound content (external comments/messages) is always approval-gated; output scanning for secrets.
- Long runs execute in worker; client polls/subscribes via Socket.IO.

## 8. RAG architecture
```
Event (document.updated, task.updated, meeting.transcribed, ...) → outbox → indexing queue
 → normalize (strip markup, add title/breadcrumbs) → chunk (~500 tokens, 60 overlap, structure-aware)
 → metadata (org, ws, sourceType, sourceId, projectId, visibility, sourceVersion)
 → embed (batched, model+version stored) → upsert KnowledgeChunk/Embedding (HNSW cosine)
Query → embed + tsvector → RRF fusion (top 50) → LIVE authorization filter (join to source tables + policy)
 → rerank (cross-encoder/LLM, top 8) → context assembly with source IDs → LLM → answer + citations
```
- Pre-filter in SQL by `workspace_id`/`organization_id` (RLS) then post-verify permission against the *current* source row (metadata is a hint, not authority).
- Incremental: re-embed only chunks whose content hash changed; deletion propagates via `*.deleted` events (soft-deleted sources excluded at query time immediately); nightly reconciliation job.
- Embedding version column allows background re-index on model change.

## 9. Agent approval architecture
State machine: `PROPOSED → PENDING_APPROVAL → APPROVED → EXECUTING → COMPLETED | FAILED(retryable) ; PENDING → REJECTED | EXPIRED`.
- `AgentAction`: type, payloadJson, `payloadHash` (SHA-256 canonical JSON), targetType/targetId, `targetVersion`, proposedBy (agent run + initiating user), expiresAt.
- `AgentApproval`: actionId, decidedBy, decision, comment, decidedAt. Approver must hold `approval:decide` for the target and cannot be restricted by self-approval policy (configurable).
- Execution worker (idempotent via unique `(actionId, attempt)` and row lock `SELECT … FOR UPDATE SKIP LOCKED`): re-verify status = APPROVED, hash matches, approver still authorized, target `version` unchanged → else mark `STALE` and notify. Execute via the *same application service* as the UI, in one transaction with audit + outbox rows. Retries with backoff for transient failures only; max attempts then DLQ. Can never run twice (terminal states + unique constraint).
- UI: before/after diff generated from payload vs. current state.

## 10. Event processing architecture
- `OutboxEvent {id, type, version, orgId, workspaceId, payload, createdAt, publishedAt, attempts}` written in the same transaction as the mutation.
- Relay (worker): polls with `FOR UPDATE SKIP LOCKED`, publishes to BullMQ queues by type; marks published. At-least-once → consumers idempotent via `processed_events(consumerName, eventId)`.
- Queues: `notifications`, `indexing`, `ai-processing`, `transcription`, `integrations-sync`, `approvals-exec`, `scheduled`. Retry exponential backoff, DLQ per queue, Bull Board (admin-only) for monitoring. Schedulers: deadline reminders, weekly report, approval expiry, outbox cleanup, index reconciliation.
- Event contracts versioned in `event-contracts` (`task.updated.v1`) with Zod schemas; breaking change = new version, consumers support N and N-1.
- Realtime: a dedicated consumer emits to Socket.IO rooms (`org:`, `ws:`, `project:`, `task:`) after commit; sockets authenticate with the session and re-check membership on join.

## 11. Security checklist (tracked in docs/security)
- [ ] RLS on every tenant table; app role without BYPASSRLS; tenant-isolation test suite
- [ ] Server-derived tenant context; ignore client-supplied org/user IDs
- [ ] RBAC + resource policies with permission matrix tests
- [ ] argon2id, session hashing, rotation, secure cookies, CSRF
- [ ] Zod validation on every input; Kysely parameterization; raw SQL only parameterized
- [ ] XSS: sanitized rich text (DOMPurify/server allowlist), CSP, no `dangerouslySetInnerHTML` without sanitizer
- [ ] Rate limiting (global, auth, AI), request IDs
- [ ] OAuth: PKCE/state, minimal scopes, AES-256-GCM encrypted tokens with key rotation (KMS-ready)
- [ ] Webhook HMAC validation + replay protection + idempotency
- [ ] Uploads: type/size allowlist, magic-byte check, AV hook, private bucket, short-lived signed URLs
- [ ] Append-only audit log (REVOKE UPDATE/DELETE, trigger blocks), covers all listed event classes
- [ ] Prompt-injection defenses, tool restrictions, approval gate
- [ ] Secrets only via env/secret manager; secret scanning in CI; dependency audit
- [ ] Security headers (Helmet), CORS allowlist, structured logging with PII redaction

## 12. UI design direction (derived from your reference images)
Combine the strongest patterns across references:
- **Shell:** collapsible icon+label sidebar with workspace switcher on top, global search (⌘K command center), notification bell, profile menu, theme toggle (light default, dark parity — refs 1, 3, 4), persistent right-side **context-aware AI assistant** panel (ref 2, 6).
- **Dashboard:** KPI stat cards (Due Today / In Progress / Completed), task trend chart, workload bars per member, mini calendar, team chat widget, storage/usage card (refs 1, 2, 8).
- **Timeline / Dependency view:** week/day/month toggle, "today" marker line, color-coded bars with assignee avatars and category chips, side detail panel with assignee/priority/status/subtasks/progress (refs 3, 5). We add dependency arrows and critical-path highlighting.
- **Risk Center / Project Health:** ranked risk cards with severity badges (Critical/High/Medium), workstream, impact, owner; segmented risk bar and gauges (refs 4, 5, 9, 10). Facts vs. inferences vs. recommendations labeled distinctly.
- **AI Assistant / PM Agent:** chat with suggested-prompt cards, active-risks side panel, AI summary insights, source citations, feedback thumbs (ref 6).
- **Calendar/Meetings:** weekly grid with quick-create popover (refs 7, 11).
- **Approval Center (new):** card list with before/after diff — no direct reference; follows the same card + badge language.
- Tokens: Inter font, 8px grid, rounded-xl cards, subtle borders, primary = indigo/violet (refs 1, 2, 4, 6) with semantic risk colors (red/orange/amber/green). Dark theme uses deep navy surfaces (refs 1, 8). Implemented as CSS variables in `packages/ui`.

## 13. Roadmap and Phase 1 plan

### Phases (as in spec)
P1 foundation/auth/orgs/RBAC → P2 projects/tasks/deps → P3 realtime/notifications/jobs → P4 AI core/RAG/meetings → P5 risk/agents/approvals → P6 integrations → P7 hardening/perf/deploy.

### Phase 1 — objective
A user can register, verify email, log in, create an organization and workspace, invite members, assign roles, and see a basic dashboard — with tenant isolation, RBAC, RLS, audit logging and outbox already in place.

### Phase 1 files to create (high level)
1. Root: `pnpm-workspace.yaml`, `turbo.json`, `package.json`, `.env.example`, `docker-compose.yml` (Postgres+pgvector, Redis, Mailpit, MinIO), `.github/workflows/ci.yml`, `README.md`, `PROJECT_STATUS.md`, `API.md`.
2. `packages/config`: tsconfig/eslint/prettier/tailwind presets, env Zod schema.
3. `packages/database`: `schema.prisma` (P1 models), migrations incl. RLS + audit append-only, tenant-context client, seed of permissions/system roles.
4. `packages/permissions`: permission constants, role matrix, `can()` policy + tests.
5. `packages/validation`: auth, org, workspace, member, invitation schemas.
6. `packages/shared`: error codes, result types, pagination helpers, id/hash utils.
7. `packages/event-contracts`: `user.registered`, `org.created`, `workspace.created`, `member.invited` v1.
8. `apps/api`: modules `auth`, `users`, `organizations`, `workspaces`, `members`, `invitations`, `roles`, `audit`, `outbox`, `health`; common guards/filters/interceptors; OpenAPI.
9. `apps/worker`: outbox relay, email queue + processor (Mailpit in dev).
10. `packages/ui`: tokens, Button, Input, Card, Dialog, Toast, Skeleton, Sidebar, Avatar, Badge, EmptyState.
11. `apps/web`: pages 1–6 (Login, Register, Forgot Password, Org Setup, Workspace Setup, Dashboard), app shell, workspace/org switcher, theme toggle, Members & Roles page (partial 28–30).
12. Tests: permission matrix, auth flows, tenant isolation (two orgs, direct SQL + API), RLS under concurrency, invitation flow, audit immutability, outbox relay idempotency, one Playwright e2e (register → org → workspace → invite).

### Phase 1 exit criteria
`pnpm install && docker compose up && pnpm dev` works; `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; tenant-isolation and permission tests green; `PROJECT_STATUS.md` updated honestly.

### Honest note on scope
The full 7-phase product is a very large build. I will implement each phase with real code and tests, run what the sandbox supports (typecheck/unit tests; Postgres/Redis integration tests need Docker or locally installed services — I'll check availability and report what I could and couldn't run).


## 14. Phase 3 — realtime, notifications, jobs (as built)

- **Outbox → relay → BullMQ** is unchanged; the relay additionally publishes an *id-only hint* (`toRealtimeHint`, allowlist) to Redis `rt:org:<orgId>` after enqueueing. Publishing is best-effort and never fails the event.
- **Notifications** are produced by a worker processor consuming `task.*` events from the `notifications` queue. Recipients are resolved at processing time through definer functions, and each delivery runs under that recipient's RLS context after re-checking org membership and workspace visibility. Idempotency: `UNIQUE(user_id, dedupe_key)` with `evt:<eventId>`; email uses check→send→record in `processed_events`. After insert, the worker publishes to `rt:user:<userId>`.
- **SSE** (`GET /organizations/:orgId/stream`): the API subscribes to the org + user channels via a `RealtimeBus` (Redis in prod, in-memory in tests). Workspace-scoped hints are forwarded only if the user can currently see that workspace; `notification` messages are accepted only from the user's own channel; the session and membership are re-validated every heartbeat and the stream is closed when either is gone. Nothing sensitive travels on the stream — clients refetch through the normal authorized API.
- **Scheduled jobs** use BullMQ job schedulers on a `maintenance` queue: `due-reminders` (every 15 min, UTC dates) and `cleanup` (daily 03:00) through `job_*` definer functions that expose only what each job needs.

## 15. Phase 4a — AI provider, documents, knowledge search (as built)

- **Provider abstraction** (`@teamos/ai-core`): `AIProvider { chat, embed }`; vendor code lives only there. Selected by `AI_PROVIDER` (`local` default, `openai` needs `OPENAI_API_KEY`). Errors carry `retryable` so the worker lets BullMQ retry only transient failures.
- **Pipeline**: document save → outbox `document.*` → `knowledge` queue → indexer re-reads the document (`job_document_state`), HTML → text → heading-aware chunks → embeddings → replace chunks in one transaction under an advisory lock (stale versions never overwrite newer ones). Deletion and missing documents remove chunks.
- **Retrieval**: `knowledge_search()` runs as the caller (RLS): keyword (`tsvector`) and vector (cosine over `real[]`) candidates fused by reciprocal rank. Authorization = the caller's current workspace visibility, never stored metadata. Chunk reads for a signed-in user need workspace visibility; the indexer (no user) uses a separate system-only policy.
- **Answering**: top chunks are numbered and given to the model inside `<sources>` with a system prompt that treats them as untrusted; invented citation numbers are stripped; the model is skipped when nothing relevant is found. Usage is recorded in `ai_usage`. The assistant is read-only.
- **Documents**: HTML sanitised server-side (allowlist), immutable `document_versions`, optimistic concurrency via `expectedVersion`.

## 16. Phase 4b — meetings and AI planning (as built)

- **Flow**: create meeting (pasted transcript and/or audio on local disk) → `process` sets PROCESSING and emits `meeting.processing_requested` → `meetings` queue → worker (transcribe if audio → extract with a zod-validated JSON schema → replace PENDING items → READY → index transcript) → `meeting.processed` hint refreshes the UI. Failures set FAILED with a reason; transient provider errors are retried by BullMQ.
- **Human-in-the-loop**: extracted items are `PENDING`. Only `approve` (permission `approval:decide`) turns an action item into a task, inside the same transaction that marks it APPROVED (`TasksService.createInTx`). A DB trigger makes decided items immutable.
- **Tenancy**: meetings follow workspace visibility via RLS; the worker acts only within one org through system policies (no user).
- **Planning**: `plan` returns a proposal and writes nothing (except usage metering); `plan/apply` creates the reviewed tasks and dependencies in one transaction. Dependencies point only to earlier tasks, so cycles are impossible.
- **Limits**: audio ≤25 MB, single-host storage (API and worker must share `STORAGE_DIR`).

## 17. Phase 5 — risk, agents, approvals (as built)

- **Risk engine**: pure functions in `@teamos/shared` over (tasks, dependencies, today). FACT = true in the data; INFERRED = propagated consequence. No model, same input → same output.
- **Agents → proposals only**: agents read through `AgentToolbox` (typed tools: project snapshot, workspace assignees). Each tool needs the user's permission and runs under their RLS context, so an agent can never see more than the person who triggered it. Output = rows in `agent_actions` (PENDING) with before/after, evidence, target version and a payload hash.
- **Approval**: `approve` (PENDING→APPROVED) then execution in one transaction: lock row → claim (APPROVED|FAILED→EXECUTING) → re-check approver permission, payload hash, target existence/status/version → apply via `TasksService.updateInTx` → EXECUTED + audit + outbox. Version mismatch → STALE (nothing applied). Exceptions roll back everything and are recorded FAILED in a second transaction. The DB trigger makes the proposal immutable and rejects illegal transitions, so even a buggy caller cannot run a rejected/executed action.
- **Expiry**: 7 days; checked at approval and swept by a maintenance job (`job_expire_agent_actions`).
- **Audit**: proposals are recorded with actor type AI (+ requesting user); decisions and executions with the approver as actor and the approval id.

## 18. Phase 6a — GitHub integration (as built)

- **Package** `@teamos/integrations`: vault (AES-256-GCM with row-bound AAD), HMAC verification, task-key extraction, `GitHubClient` (injectable `fetch`, configurable base URLs).
- **Tables** (migration 0008): `integrations`, `integration_tokens` (system context only), `integration_repos`, `external_items` (read via workspace visibility), `task_links`, `webhook_events` (system only), `oauth_states`. SECURITY DEFINER helpers: `webhook_repo_lookup`, `job_sync_repos`, `job_find_task` (the background context cannot read `tasks`).
- **Flow**: API receives a signed webhook → stores `webhook_events` (unique per repo+delivery) + outbox event in one transaction → worker `integrations` queue processes it (idempotent) → upserts items, auto-links tasks, emits `github.pull_request.updated.v1` → id-only realtime hint.
- **Disconnect ordering** is deliberate: flip status in the database first, then remove external hooks, then destroy the token; workers revalidate the status under a row lock before writing.
- Kysely `CamelCasePlugin` now keeps nested JSONB keys (`maintainNestedObjectKeys`) so provider payloads are stored and read verbatim.

## 19. Phase 6b — Google Calendar and Gmail (as built)

Shares the Phase 6a design: AES-256-GCM token vault (`integration_tokens`, system context only), single-use hashed OAuth state bound to user + org, role re-checked at callback, disconnect-first ordering, worker re-check under row lock.

- **Providers**: `GOOGLE_CALENDAR` and `GOOGLE_MAIL` are separate integrations with read-only scopes (`calendar.readonly`, `gmail.readonly`), `access_type=offline`, `prompt=consent`. The token blob `{accessToken, refreshToken, expiresAt}` is encrypted as one value and refreshed 60 s early (logic exists in both API and worker).
- **Calendar sync** (`apps/worker/src/google.processor.ts`): incremental by `syncToken`; HTTP 410 → full resync; a complete full listing deletes vanished events, an incomplete one deletes nothing. Window −14d/+90d. Only title, time, attendee count and link are stored. `meeting_calendar_links` is 1:1 and fills `meetings.held_at` when empty.
- **Gmail sync**: only messages with a configured label (validated); ≤4000-char excerpt. Project by task key (`job_find_project`, same workspace) else the mailbox default. The AI produces PENDING `email_items` (DECISION / ACTION_ITEM); `approval:decide` users approve, and an approved action item creates a task via `TasksService.createInTx` in the same transaction. Decided items are immutable (`email_items_guard` trigger).
- **Scheduling**: `integration.google_sync_requested.v1` on connect/"Sync now"; `google-sync` maintenance job every 15 min. A revoked refresh token → ERROR, no retry storm.
- **RLS**: sources admin/system only; events read-only to users by workspace visibility; links/messages/items by workspace visibility; `job_sync_*` and `job_find_project` are SECURITY DEFINER for the background context.
- **Not built**: push notifications (Google watch), write access, per-user connections, reprocessing FAILED messages.

## 20. Phase 7 — hardening, performance, monitoring, deployment (as built)

* **Production config guard** (`packages/config`): in `NODE_ENV=production` the process refuses to start on http URLs, placeholder/low-entropy `AUTH_SECRET`, a DB role of `postgres`/`migrator`/`root` (would bypass RLS), `AI_PROVIDER=local` (unless `ALLOW_LOCAL_AI=true`), OpenAI without a key, or SMTP on localhost. Errors name the setting, never the value. Empty env values (compose) are treated as unset.
* **RLS performance** (migration 0011): workspace visibility is a set (`app_visible_workspaces()`), evaluated once per query as a hashed subplan instead of per row. Equivalence is asserted inside the migration and by tests. Lesson recorded in `docs/PERFORMANCE.md`: with RLS, non-leakproof operators (`ILIKE`, enum `=`) cannot be index conditions for `app_user`.
* **Bounded reads**: project task listing is capped at 2,000 rows with `meta.total` for truncation.
* **Observability**: `X-Request-Id` end to end; JSON access log (route templates only); API `/health/live`, `/health/ready` (Postgres + Redis), `/metrics` (bearer, route-template labels); worker listener on `WORKER_HTTP_PORT` with queue depth, job outcomes and outbox backlog/lag (`outbox_stats()` is aggregate-only, migration 0010). A failing collector does not break a scrape.
* **Web headers**: CSP, HSTS (prod), Permissions-Policy, COOP in `next.config.mjs`; `output: 'standalone'`.
* **Authorization regression net**: `hardening.e2e.test.ts` enumerates every controller route, pins the public set, requires rate limits on credential endpoints and snapshots member-level routes.
* **Mail**: `SMTP_USER/PASSWORD/SECURE`; STARTTLS required in production.
* **Packaging**: one multi-target `Dockerfile` (api, worker, migrate, web; non-root, tini, healthchecks), `docker-compose.prod.yml`, Caddy (TLS, SSE-safe), `infrastructure/prod/init-roles.sh` (roles from env, no hard-coded passwords), `scripts/ops/{backup,restore-check}.sh`. Runbook: `docs/DEPLOYMENT.md`.
* **Found by building for production**: `dist/main.js` could not start (`Cannot find module './express.d'`) because dev/test run through tsx and the compiled build had never been executed. Fixed (`/// <reference>`), and the deploy bundles are now booted as part of verification.

