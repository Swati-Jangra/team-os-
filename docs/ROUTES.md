# Route reference

_Generated from the controllers by `apps/api/src/test/hardening.e2e.test.ts`. Do not edit by hand: run `WRITE_ROUTES_DOC=1 pnpm --filter @teamos/api test hardening` after adding or changing a route. The test fails when this file is stale._

This is a route/permission index, **not** an OpenAPI document: request and response schemas are in `docs/API.md` and `packages/validation`.

| Method | Path | Access | Own rate limit |
|---|---|---|---|
| POST | `/api/v1/auth/forgot-password` | public | yes |
| POST | `/api/v1/auth/login` | public | yes |
| POST | `/api/v1/auth/logout` | signed-in user |  |
| GET | `/api/v1/auth/me` | signed-in user |  |
| POST | `/api/v1/auth/register` | public | yes |
| POST | `/api/v1/auth/reset-password` | public | yes |
| GET | `/api/v1/auth/sessions` | signed-in user |  |
| DELETE | `/api/v1/auth/sessions/:id` | signed-in user |  |
| POST | `/api/v1/auth/verify-email` | public | yes |
| GET | `/api/v1/health` | public |  |
| GET | `/api/v1/health/live` | public |  |
| GET | `/api/v1/health/ready` | public |  |
| GET | `/api/v1/integrations/github/callback` | signed-in user |  |
| GET | `/api/v1/integrations/google/callback` | signed-in user |  |
| POST | `/api/v1/invitations/accept` | signed-in user | yes |
| GET | `/api/v1/me/notification-preferences` | signed-in user |  |
| PUT | `/api/v1/me/notification-preferences` | signed-in user |  |
| GET | `/api/v1/organizations` | signed-in user |  |
| POST | `/api/v1/organizations` | signed-in user | yes |
| GET | `/api/v1/organizations/:orgId` | `org:read` |  |
| PATCH | `/api/v1/organizations/:orgId` | `org:update` |  |
| GET | `/api/v1/organizations/:orgId/agent-actions` | `approval:read` |  |
| GET | `/api/v1/organizations/:orgId/agent-actions/:actionId` | `approval:read` |  |
| POST | `/api/v1/organizations/:orgId/agent-actions/:actionId/approve` | `approval:decide` |  |
| POST | `/api/v1/organizations/:orgId/agent-actions/:actionId/reject` | `approval:decide` |  |
| POST | `/api/v1/organizations/:orgId/agent-actions/:actionId/retry` | `approval:decide` |  |
| GET | `/api/v1/organizations/:orgId/audit-logs` | `audit:read` |  |
| GET | `/api/v1/organizations/:orgId/calendar/events` | `project:read` |  |
| DELETE | `/api/v1/organizations/:orgId/comments/:commentId` | `comment:create` |  |
| PATCH | `/api/v1/organizations/:orgId/comments/:commentId` | `comment:create` |  |
| GET | `/api/v1/organizations/:orgId/documents` | `document:read` |  |
| POST | `/api/v1/organizations/:orgId/documents` | `document:write` |  |
| DELETE | `/api/v1/organizations/:orgId/documents/:documentId` | `document:write` |  |
| GET | `/api/v1/organizations/:orgId/documents/:documentId` | `document:read` |  |
| PATCH | `/api/v1/organizations/:orgId/documents/:documentId` | `document:write` |  |
| GET | `/api/v1/organizations/:orgId/documents/:documentId/versions` | `document:read` |  |
| GET | `/api/v1/organizations/:orgId/documents/:documentId/versions/:version` | `document:read` |  |
| POST | `/api/v1/organizations/:orgId/documents/:documentId/versions/:version/restore` | `document:write` |  |
| GET | `/api/v1/organizations/:orgId/emails` | `document:read` |  |
| GET | `/api/v1/organizations/:orgId/emails/:messageId` | `document:read` |  |
| PATCH | `/api/v1/organizations/:orgId/emails/:messageId/items/:itemId` | `approval:decide` |  |
| POST | `/api/v1/organizations/:orgId/emails/:messageId/items/:itemId/approve` | `approval:decide` |  |
| POST | `/api/v1/organizations/:orgId/emails/:messageId/items/:itemId/reject` | `approval:decide` |  |
| PUT | `/api/v1/organizations/:orgId/emails/:messageId/project` | `task:create` |  |
| GET | `/api/v1/organizations/:orgId/external-items` | `project:read` |  |
| GET | `/api/v1/organizations/:orgId/google` | `project:read` |  |
| DELETE | `/api/v1/organizations/:orgId/google/:integrationId` | `integration:manage` |  |
| POST | `/api/v1/organizations/:orgId/google/:integrationId/calendar-sources` | `integration:manage` |  |
| GET | `/api/v1/organizations/:orgId/google/:integrationId/calendars` | `integration:manage` |  |
| POST | `/api/v1/organizations/:orgId/google/:integrationId/mailbox` | `integration:manage` |  |
| DELETE | `/api/v1/organizations/:orgId/google/calendar-sources/:sourceId` | `integration:manage` |  |
| POST | `/api/v1/organizations/:orgId/google/calendar-sources/:sourceId/sync` | `integration:manage` |  |
| POST | `/api/v1/organizations/:orgId/google/calendar/authorize` | `integration:manage` |  |
| POST | `/api/v1/organizations/:orgId/google/mail/authorize` | `integration:manage` |  |
| DELETE | `/api/v1/organizations/:orgId/google/mailboxes/:sourceId` | `integration:manage` |  |
| POST | `/api/v1/organizations/:orgId/google/mailboxes/:sourceId/sync` | `integration:manage` |  |
| DELETE | `/api/v1/organizations/:orgId/integration-repos/:repoId` | `integration:manage` |  |
| POST | `/api/v1/organizations/:orgId/integration-repos/:repoId/sync` | `integration:manage` |  |
| GET | `/api/v1/organizations/:orgId/integrations` | `project:read` |  |
| DELETE | `/api/v1/organizations/:orgId/integrations/:integrationId` | `integration:manage` |  |
| GET | `/api/v1/organizations/:orgId/integrations/:integrationId/available-repos` | `integration:manage` |  |
| POST | `/api/v1/organizations/:orgId/integrations/:integrationId/repos` | `integration:manage` |  |
| POST | `/api/v1/organizations/:orgId/integrations/github/authorize` | `integration:manage` |  |
| GET | `/api/v1/organizations/:orgId/invitations` | `member:invite` |  |
| POST | `/api/v1/organizations/:orgId/invitations` | `member:invite` |  |
| DELETE | `/api/v1/organizations/:orgId/invitations/:invitationId` | `member:invite` |  |
| POST | `/api/v1/organizations/:orgId/knowledge/ask` | `ai:use` |  |
| POST | `/api/v1/organizations/:orgId/knowledge/search` | `document:read` |  |
| GET | `/api/v1/organizations/:orgId/meetings` | `document:read` |  |
| POST | `/api/v1/organizations/:orgId/meetings` | `meeting:manage` |  |
| DELETE | `/api/v1/organizations/:orgId/meetings/:meetingId` | `meeting:manage` |  |
| GET | `/api/v1/organizations/:orgId/meetings/:meetingId` | `document:read` |  |
| PATCH | `/api/v1/organizations/:orgId/meetings/:meetingId` | `meeting:manage` |  |
| PUT | `/api/v1/organizations/:orgId/meetings/:meetingId/audio` | `meeting:manage` | yes |
| DELETE | `/api/v1/organizations/:orgId/meetings/:meetingId/calendar-event` | `meeting:manage` |  |
| GET | `/api/v1/organizations/:orgId/meetings/:meetingId/calendar-event` | `document:read` |  |
| POST | `/api/v1/organizations/:orgId/meetings/:meetingId/calendar-event` | `meeting:manage` |  |
| PATCH | `/api/v1/organizations/:orgId/meetings/:meetingId/items/:itemId` | `approval:decide` |  |
| POST | `/api/v1/organizations/:orgId/meetings/:meetingId/items/:itemId/approve` | `approval:decide` |  |
| POST | `/api/v1/organizations/:orgId/meetings/:meetingId/items/:itemId/reject` | `approval:decide` |  |
| POST | `/api/v1/organizations/:orgId/meetings/:meetingId/process` | `meeting:manage` | yes |
| GET | `/api/v1/organizations/:orgId/members` | `member:read` |  |
| DELETE | `/api/v1/organizations/:orgId/members/:userId` | `member:remove` |  |
| PUT | `/api/v1/organizations/:orgId/members/:userId/role` | `member:role_update` |  |
| DELETE | `/api/v1/organizations/:orgId/milestones/:milestoneId` | `project:update` |  |
| PATCH | `/api/v1/organizations/:orgId/milestones/:milestoneId` | `project:update` |  |
| GET | `/api/v1/organizations/:orgId/notifications` | org member (own data) |  |
| POST | `/api/v1/organizations/:orgId/notifications/:id/read` | org member (own data) |  |
| POST | `/api/v1/organizations/:orgId/notifications/read-all` | org member (own data) |  |
| GET | `/api/v1/organizations/:orgId/notifications/unread-count` | org member (own data) |  |
| GET | `/api/v1/organizations/:orgId/projects` | `project:read` |  |
| POST | `/api/v1/organizations/:orgId/projects` | `project:create` |  |
| DELETE | `/api/v1/organizations/:orgId/projects/:projectId` | `project:delete` |  |
| GET | `/api/v1/organizations/:orgId/projects/:projectId` | `project:read` |  |
| PATCH | `/api/v1/organizations/:orgId/projects/:projectId` | `project:update` |  |
| GET | `/api/v1/organizations/:orgId/projects/:projectId/activity` | `project:read` |  |
| POST | `/api/v1/organizations/:orgId/projects/:projectId/agent-proposals` | `ai:use` |  |
| GET | `/api/v1/organizations/:orgId/projects/:projectId/milestones` | `project:read` |  |
| POST | `/api/v1/organizations/:orgId/projects/:projectId/milestones` | `project:update` |  |
| POST | `/api/v1/organizations/:orgId/projects/:projectId/plan` | `ai:use` |  |
| POST | `/api/v1/organizations/:orgId/projects/:projectId/plan/apply` | `task:create` |  |
| GET | `/api/v1/organizations/:orgId/projects/:projectId/risks` | `project:read` |  |
| GET | `/api/v1/organizations/:orgId/projects/:projectId/tasks` | `task:read` |  |
| POST | `/api/v1/organizations/:orgId/projects/:projectId/tasks` | `task:create` |  |
| GET | `/api/v1/organizations/:orgId/risks` | `project:read` |  |
| GET | `/api/v1/organizations/:orgId/stream` | org member (own data) |  |
| DELETE | `/api/v1/organizations/:orgId/tasks/:taskId` | `task:delete` |  |
| GET | `/api/v1/organizations/:orgId/tasks/:taskId` | `task:read` |  |
| PATCH | `/api/v1/organizations/:orgId/tasks/:taskId` | `task:update` |  |
| GET | `/api/v1/organizations/:orgId/tasks/:taskId/activity` | `task:read` |  |
| GET | `/api/v1/organizations/:orgId/tasks/:taskId/comments` | `comment:read` |  |
| POST | `/api/v1/organizations/:orgId/tasks/:taskId/comments` | `comment:create` |  |
| POST | `/api/v1/organizations/:orgId/tasks/:taskId/dependencies` | `task:update` |  |
| DELETE | `/api/v1/organizations/:orgId/tasks/:taskId/dependencies/:dependsOnId` | `task:update` |  |
| GET | `/api/v1/organizations/:orgId/tasks/:taskId/links` | `task:read` |  |
| POST | `/api/v1/organizations/:orgId/tasks/:taskId/links` | `task:update` |  |
| DELETE | `/api/v1/organizations/:orgId/tasks/:taskId/links/:linkId` | `task:update` |  |
| GET | `/api/v1/organizations/:orgId/tasks/mine` | `task:read` |  |
| GET | `/api/v1/organizations/:orgId/workspaces` | `workspace:read` |  |
| POST | `/api/v1/organizations/:orgId/workspaces` | `workspace:create` |  |
| DELETE | `/api/v1/organizations/:orgId/workspaces/:workspaceId` | `workspace:delete` |  |
| GET | `/api/v1/organizations/:orgId/workspaces/:workspaceId` | `workspace:read` |  |
| PATCH | `/api/v1/organizations/:orgId/workspaces/:workspaceId` | `workspace:update` |  |
| GET | `/api/v1/organizations/:orgId/workspaces/:workspaceId/members` | `workspace:read` |  |
| POST | `/api/v1/organizations/:orgId/workspaces/:workspaceId/members` | `workspace:update` |  |
| DELETE | `/api/v1/organizations/:orgId/workspaces/:workspaceId/members/:userId` | `workspace:update` |  |
| POST | `/api/v1/webhooks/github/:repoId` | public | yes |
