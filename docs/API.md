# TeamOS AI — API (v1)

Base path `/api/v1`. JSON only.
Success: `{ "data": …, "meta": { page, pageSize, total, totalPages } }` (meta on lists).
Error: `{ "error": { "code", "message", "details", "requestId" } }`. Every response carries `X-Request-Id`.

**Auth:** opaque session in httpOnly cookie `teamos_session`. For non-GET requests send the value of the `teamos_csrf` cookie in the `x-csrf-token` header. Tenant is taken only from the `:orgId` path and verified against the DB; non-members receive `404`.
**Guards (order):** rate limit → auth → tenant → permission.

| Method & path | Permission | Notes |
|---|---|---|
| POST `/auth/register` | public | Uniform response (no enumeration) |
| POST `/auth/verify-email` | public | `{token}`, single use |
| POST `/auth/login` | public | Lockout after repeated failures |
| POST `/auth/logout` | session | Revokes current session |
| GET `/auth/me` | session | User + memberships |
| GET `/auth/sessions`, DELETE `/auth/sessions/:id` | session | List / revoke own sessions |
| POST `/auth/forgot-password` | public | Uniform response |
| POST `/auth/reset-password` | public | Revokes all sessions |
| GET `/health` | public | |
| GET/POST `/organizations` | session | List mine / create (caller becomes OWNER) |
| GET `/organizations/:orgId` | member | |
| PATCH `/organizations/:orgId` | `org:update` | |
| GET `/organizations/:orgId/members` | `member:read` | |
| PUT `/organizations/:orgId/members/:userId/role` | `member:role_update` | Rank rules; last-owner protected |
| DELETE `/organizations/:orgId/members/:userId` | `member:remove` | Last-owner protected |
| GET/POST `/organizations/:orgId/invitations` | `member:invite` | OWNER cannot be granted by invite |
| DELETE `/organizations/:orgId/invitations/:invitationId` | `member:invite` | Revoke |
| POST `/invitations/accept` | session | `{token}`; email must match |
| GET/POST `/organizations/:orgId/workspaces` | `workspace:read` / `workspace:create` | |
| GET/PATCH/DELETE `/organizations/:orgId/workspaces/:workspaceId` | read / update / delete | |
| GET/POST `/organizations/:orgId/workspaces/:workspaceId/members` | read / update | |
| DELETE `…/workspaces/:workspaceId/members/:userId` | `workspace:update` | |
| GET `/organizations/:orgId/audit-logs` | `audit:read` | `page`, `pageSize`, `action` filter |

Request body schemas live in `packages/validation/src` (shared with the web forms).

## Phase 2 — projects, milestones, tasks, dependencies, comments, activity

All under `/organizations/:orgId`. A row is visible only if the caller is org OWNER/ADMIN or a member of its workspace (enforced by RLS); anything else returns `404`.

| Method & path | Permission | Notes |
|---|---|---|
| GET `/projects?workspaceId=&status=` | `project:read` | Includes `taskCount` / `doneCount` |
| POST `/projects` | `project:create` | `{workspaceId, name, key?, …}`; key derived if omitted; `409` on duplicate key |
| GET / PATCH / DELETE `/projects/:projectId` | read / `project:update` / `project:delete` | DELETE is a soft delete that also hides tasks |
| GET / POST `/projects/:projectId/milestones` | `project:read` / `project:update` | |
| PATCH / DELETE `/milestones/:milestoneId` | `project:update` | DELETE detaches its tasks |
| GET / POST `/projects/:projectId/tasks` | `task:read` / `task:create` | Filters: `status, assigneeId, milestoneId, q`. Per-project numbering (`KEY-n`) |
| GET `/tasks/mine` | `task:read` | Open tasks assigned to me |
| GET / PATCH / DELETE `/tasks/:taskId` | read / `task:update` / `task:delete` | GET includes `blockedBy`, `blocks` |
| POST `/tasks/:taskId/dependencies` | `task:update` | `{dependsOnTaskId}`; `409` on cycle; `400` across workspaces |
| DELETE `/tasks/:taskId/dependencies/:dependsOnId` | `task:update` | |
| GET / POST `/tasks/:taskId/comments` | `comment:read` / `comment:create` | |
| PATCH / DELETE `/comments/:commentId` | `comment:create` | Edit: author only. Delete: author or `task:delete` |
| GET `/projects/:projectId/activity`, `/tasks/:taskId/activity` | read | Append-only feed visible to workspace members |

Business rules: assigning someone else needs `task:assign` (self-assign is always allowed); the assignee must be an org OWNER/ADMIN or a workspace member; a task cannot be set to `DONE` while any task it depends on is not `DONE`/`CANCELLED` (`409`, `details.blockers`); dates are `YYYY-MM-DD` and `dueDate >= startDate`.
Events written to the outbox: `project.created.v1`, `task.created.v1`, `task.assigned.v1`, `task.status_changed.v1`, `task.commented.v1`.

## Phase 3 — notifications and live updates

All routes under `/api/v1`. Any org member may use them; rows are scoped to the caller by RLS (someone else's notification is a 404).

| Method | Path | Notes |
|---|---|---|
| GET | `/organizations/:orgId/notifications?page&pageSize&unread=true` | Paged list, newest first |
| GET | `/organizations/:orgId/notifications/unread-count` | `{count}` |
| POST | `/organizations/:orgId/notifications/:id/read` | Idempotent; 404 if not yours |
| POST | `/organizations/:orgId/notifications/read-all` | `{updated}` |
| GET | `/me/notification-preferences` | One row per category, defaults filled in |
| PUT | `/me/notification-preferences` | `{preferences:[{category,inApp,email}]}` |
| GET | `/organizations/:orgId/stream` | Server-Sent Events |

Categories: `TASK_ASSIGNED`, `TASK_COMMENT`, `TASK_STATUS`, `TASK_DUE`.

### Stream events
`ready`, `hint` (`{type, workspaceId?, projectId?, taskId?}` — ids only, client refetches), `notification` (`{id, category, title, link}`, only the caller's own), `close` (`{reason: "session_ended" | "access_revoked"}`). A `: ping` comment is sent every heartbeat. 401 if unauthenticated, 404 for non-members, 429 over the per-user stream cap.

## Phase 4a — documents and knowledge

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/organizations/:orgId/documents?workspaceId&projectId&page&pageSize` | document:read | Summaries (no body) |
| POST | `/organizations/:orgId/documents` | document:write | `{workspaceId, title, contentHtml?, projectId?}`; 404 if you can't see the workspace |
| GET | `/organizations/:orgId/documents/:id` | document:read | Includes `contentHtml` (sanitised) |
| PATCH | `/organizations/:orgId/documents/:id` | document:write | `{title?, contentHtml?, projectId?, expectedVersion}`; **409** if `expectedVersion` is stale |
| DELETE | `/organizations/:orgId/documents/:id` | document:write | Soft delete; removes it from search |
| GET | `/organizations/:orgId/documents/:id/versions` | document:read | Newest first |
| GET | `/organizations/:orgId/documents/:id/versions/:n` | document:read | Full content of version n |
| POST | `/organizations/:orgId/documents/:id/versions/:n/restore` | document:write | `{expectedVersion}`; appends a NEW version |
| POST | `/organizations/:orgId/knowledge/search` | document:read | `{query, workspaceId?, limit?}` → `{results:[{chunkId, sourceType, sourceId, workspaceId, title, heading, snippet, score, matched:{keyword,vector}}]}` |
| POST | `/organizations/:orgId/knowledge/ask` | ai:use | `{question, workspaceId?}` → `{answer, grounded, sources:[{n, cited, ...hit}], provider, model}` |

Errors: `429` per-user AI limits (300 searches / 60 questions per hour); `503 AI_UNAVAILABLE` when the provider fails. Live hints: `document.created|updated|deleted` (ids only).

## Phase 4b — meetings and AI planning

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/organizations/:orgId/meetings?workspaceId&projectId&page&pageSize` | document:read | Summaries (no transcript) |
| POST | `/organizations/:orgId/meetings` | meeting:manage | `{workspaceId, title, projectId?, heldAt?, transcript?}` |
| GET | `/organizations/:orgId/meetings/:id` | document:read | Includes transcript and items |
| PATCH | `/organizations/:orgId/meetings/:id` | meeting:manage | **409** while PROCESSING |
| DELETE | `/organizations/:orgId/meetings/:id` | meeting:manage | Soft delete; removes from search |
| PUT | `/organizations/:orgId/meetings/:id/audio` | meeting:manage | Raw body, `Content-Type: audio/mpeg\|wav\|mp4\|webm\|ogg`; ≤25 MB (**413** when larger) |
| POST | `/organizations/:orgId/meetings/:id/process` | meeting:manage | Queues transcription + extraction; 400 with no transcript/audio, 409 if already processing |
| PATCH | `/organizations/:orgId/meetings/:id/items/:itemId` | approval:decide | `{text?, dueDate?, priority?}` while PENDING |
| POST | `…/items/:itemId/approve` | approval:decide | Action items need `{projectId}` (same workspace), optional `assigneeId`, etc. → `{item, taskId}`; creates the task atomically; **409** if already decided |
| POST | `…/items/:itemId/reject` | approval:decide | → `{item, taskId: null}` |
| POST | `/organizations/:orgId/projects/:id/plan` | ai:use | `{goal?}` → `{tasks:[{title, description?, priority?, estimateHours?, dependsOn:number[]}], provider, model}`. Read-only. 30/h per user; 503 `AI_UNAVAILABLE` |
| POST | `/organizations/:orgId/projects/:id/plan/apply` | task:create | `{tasks:[…]}`; `dependsOn` may only reference earlier indexes; creates tasks + dependencies atomically |

Live hints: `meeting.created|updated|processed|deleted` (ids only).

## Phase 5 — risks, agent proposals, approvals

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/organizations/:orgId/risks?workspaceId` | project:read | Open projects the caller can see, riskiest first: `{today, projects:[{projectId, key, name, dueDate, counts, findings:[{kind, basis: FACT\|INFERRED, severity, identifier, message, recommendation, relatedTaskIds, slipDays?}]}]}` |
| GET | `/organizations/:orgId/projects/:id/risks` | project:read | Same shape, one project (404 if not visible) |
| POST | `/organizations/:orgId/projects/:id/agent-proposals` | ai:use | `{agent?: DEPENDENCY_RISK\|TASK_MANAGEMENT}` → newly created PENDING actions (none if already proposed). **Changes no task.** 30 runs/h per user |
| GET | `/organizations/:orgId/agent-actions?status&projectId&page&pageSize` | approval:read | Workspace-visible only |
| GET | `/organizations/:orgId/agent-actions/:id` | approval:read | before/after, evidence, status, attempts, lastError |
| POST | `…/agent-actions/:id/approve` | approval:decide | `{note?}` → decides and executes; result status EXECUTED, STALE (target changed) or FAILED. **409** if not PENDING or expired |
| POST | `…/agent-actions/:id/reject` | approval:decide | `{note?}`; a rejected action can never run |
| POST | `…/agent-actions/:id/retry` | approval:decide | Only for FAILED (max 3 attempts); revalidated from scratch |

Live hints: `agent.action.proposed|approved|rejected|completed` (ids only).

## Phase 6a — GitHub integration

Org-scoped routes live under `/organizations/:orgId`. Writes need `integration:manage` (Owner/Admin); reads need `project:read`.

| Method & path | Permission | Notes |
|---|---|---|
| `GET /integrations` | project:read | `{configured, integration, repos}`; never includes tokens/secrets |
| `POST /integrations/github/authorize` | integration:manage | returns `{url}` to send the browser to; 503 `INTEGRATION_NOT_CONFIGURED` if unconfigured |
| `GET /api/v1/integrations/github/callback?code&state` | session | no `:orgId`; single-use state; 302 to `/o/:org/integrations?connected=github` |
| `DELETE /integrations/:id` | integration:manage | disconnect: stops sync/webhooks, removes hooks, deletes token |
| `GET /integrations/:id/available-repos` | integration:manage | repos the GitHub account can see |
| `POST /integrations/:id/repos` | integration:manage | `{fullName, workspaceId, projectId?}` → 201; creates the webhook |
| `DELETE /integration-repos/:repoId` | integration:manage | |
| `POST /integration-repos/:repoId/sync` | integration:manage | 202; 429 if requested within 30 s |
| `GET /external-items?workspaceId&kind&q&page` | project:read | paged; only workspaces the caller can see; includes linked task identifiers |
| `GET/POST /tasks/:taskId/links`, `DELETE /tasks/:taskId/links/:linkId` | task:read / task:update | POST `{itemId}`; item and task must share a workspace |
| `POST /api/v1/webhooks/github/:repoId` | public (signature) | needs `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`; 202 (`duplicate:true` on redelivery), 401 bad signature, 404 unknown/disconnected |

## Google Calendar and Gmail (Phase 6b)

All routes are under `/organizations/:orgId`, unless noted. Without `INTEGRATION_ENCRYPTION_KEY` + Google credentials, `GET /google` returns `configured:false`.

| Route | Permission | Notes |
|---|---|---|
| `GET /google` | integration:manage | `{configured, calendar:{integration,sources}, mail:{integration,source}}` |
| `POST /google/calendar/authorize`, `POST /google/mail/authorize` | integration:manage | returns `{url}` for the consent screen |
| `DELETE /google/:integrationId` | integration:manage | revokes at Google, deletes token, stops sync |
| `GET /google/:integrationId/calendars` | integration:manage | calendars available to connect |
| `POST /google/:integrationId/calendar-sources` | integration:manage | `{calendarId, workspaceId}` |
| `DELETE /google/calendar-sources/:sourceId`, `POST …/sync` | integration:manage | sync: 202, 429 if within 30 s |
| `GET /calendar/events?from&to&workspaceId` | project:read | range ≤120 days; `conflict` flag |
| `GET/POST/DELETE /meetings/:meetingId/calendar-event` | meeting:manage (write) | 1:1 link |
| `POST /google/:integrationId/mailbox` | integration:manage | `{label, workspaceId, defaultProjectId?}`; one per integration |
| `DELETE /google/mailboxes/:sourceId`, `POST …/sync` | integration:manage | |
| `GET /emails`, `GET /emails/:messageId` | document:read | by workspace visibility |
| `PUT /emails/:messageId/project` | document:read + project access | link / unlink |
| `PATCH /email-items/:itemId`, `POST …/approve`, `POST …/reject` | approval:decide | approve of an action item `{projectId}` creates a task; 409 if already decided |
| `GET /api/v1/integrations/google/callback` | public (state) | redirects to `/o/:org/integrations?connected=google` or `?error=…` |

## Operations endpoints (Phase 7)

| Route | Auth | Notes |
|---|---|---|
| `GET /api/v1/health` | public | database check only (kept for compatibility) |
| `GET /api/v1/health/live` | public | `{status:"live"}`; no dependency checks |
| `GET /api/v1/health/ready` | public | `{status:"ready"|"unavailable", checks:{database,redis}}`; **503** when unavailable |
| `GET /metrics` | `Authorization: Bearer $METRICS_TOKEN` | Prometheus text; **404** when no token is configured; **outside** `/api/v1` so the proxy does not expose it |
| worker `GET :$WORKER_HTTP_PORT/health/live`, `/health/ready`, `/metrics` | same token for metrics | private network only |

Changed: `GET /organizations/:orgId/projects/:projectId/tasks` returns at most **2000** tasks; `meta.total` is the real total (`data` is still an array).
Every response carries `X-Request-Id`.

