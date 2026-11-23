-- 0001_init: Phase 1 schema (identity, tenancy, RBAC catalog, audit, outbox).
-- Owned/applied by the `migrator` role. RLS + grants live in 0002.

CREATE TYPE member_role AS ENUM
  ('OWNER','ADMIN','PROJECT_MANAGER','TEAM_LEAD','DEVELOPER','VIEWER','GUEST');
CREATE TYPE email_token_type AS ENUM ('VERIFY_EMAIL','PASSWORD_RESET');
CREATE TYPE actor_type AS ENUM ('USER','AI','SYSTEM');

-- ---------- identity (global, not tenant-scoped) ----------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL UNIQUE,
  name               text NOT NULL,
  password_hash      text NOT NULL,
  email_verified_at  timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  csrf_token   text NOT NULL,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE email_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       email_token_type NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_idx ON email_tokens(user_id, type);

-- ---------- tenancy ----------
CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE organization_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  role            member_role NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members(user_id) WHERE deleted_at IS NULL;

CREATE TABLE workspaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  slug            text NOT NULL,
  description     text,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, slug),
  UNIQUE (organization_id, id)          -- target for composite tenant-aware FKs
);

CREATE TABLE workspace_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  user_id         uuid NOT NULL,
  role            member_role NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (workspace_id, user_id),
  -- a workspace member must belong to the same org as the workspace AND be an org member
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id),
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id) WHERE deleted_at IS NULL;

CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, id)
);

CREATE TABLE team_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  team_id         uuid NOT NULL,
  user_id         uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id),
  FOREIGN KEY (organization_id, team_id) REFERENCES teams(organization_id, id),
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id)
);

-- ---------- RBAC catalog ----------
-- P1: system roles/permissions are mirrored here from @teamos/permissions (code is the source of truth).
-- Custom org roles are modelled but not yet editable.
CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  description text
);

CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),   -- NULL = system role
  name            text NOT NULL,
  description     text,
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE UNIQUE INDEX roles_system_name_uniq ON roles(name) WHERE organization_id IS NULL;

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ---------- invitations ----------
CREATE TABLE invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email           text NOT NULL,
  role            member_role NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  invited_by_id   uuid NOT NULL REFERENCES users(id),
  workspace_ids   uuid[] NOT NULL DEFAULT '{}',
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by_id  uuid REFERENCES users(id),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT invitations_not_owner CHECK (role <> 'OWNER')
);
CREATE UNIQUE INDEX invitations_pending_uniq
  ON invitations(organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------- audit (append-only; enforced in 0002) ----------
CREATE TABLE audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  workspace_id    uuid,
  actor_type      actor_type NOT NULL,
  actor_id        uuid,                -- no FK on purpose: audit must outlive users
  action          text NOT NULL,
  target_type     text,
  target_id       text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id      text,
  approval_id     uuid,                -- FK added when agent approvals exist (Phase 5)
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_created_idx ON audit_logs(organization_id, created_at DESC);
CREATE INDEX audit_logs_org_action_idx ON audit_logs(organization_id, action);

-- ---------- transactional outbox ----------
CREATE TABLE outbox_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  organization_id uuid,
  workspace_id    uuid,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  locked_at       timestamptz,
  last_error      text
);
CREATE INDEX outbox_unpublished_idx ON outbox_events(created_at) WHERE published_at IS NULL;

CREATE TABLE processed_events (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
