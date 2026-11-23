/**
 * Central permission model. Pure functions only — no I/O — so it can be used by
 * the API, the worker, agent tools and (types only) the web app.
 */

export const ROLES = [
  'OWNER',
  'ADMIN',
  'PROJECT_MANAGER',
  'TEAM_LEAD',
  'DEVELOPER',
  'VIEWER',
  'GUEST',
] as const;
export type RoleName = (typeof ROLES)[number];

export const PERMISSIONS = [
  // organization
  'org:read',
  'org:update',
  'org:delete',
  'org:billing',
  // members
  'member:read',
  'member:invite',
  'member:remove',
  'member:role_update',
  // roles
  'role:manage',
  // workspaces
  'workspace:create',
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'team:manage',
  // audit
  'audit:read',
  // projects & tasks (Phase 2+)
  'project:create',
  'project:read',
  'project:update',
  'project:delete',
  'task:create',
  'task:read',
  'task:update',
  'task:delete',
  'task:assign',
  'comment:create',
  'comment:read',
  // knowledge (Phase 4+)
  'meeting:manage',
  'document:read',
  'document:write',
  // AI + agents (Phase 4/5+)
  'ai:use',
  'approval:read',
  'approval:decide',
  // integrations (Phase 6+)
  'integration:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

const READ_ONLY: Permission[] = [
  'org:read',
  'member:read',
  'workspace:read',
  'project:read',
  'task:read',
  'comment:read',
  'document:read',
  'approval:read',
];

const DEVELOPER: Permission[] = [
  ...READ_ONLY,
  'task:create',
  'task:update',
  'comment:create',
  'document:write',
  'ai:use',
];

const TEAM_LEAD: Permission[] = [
  ...DEVELOPER,
  'task:assign',
  'task:delete',
  'project:update',
  'team:manage',
];

const PROJECT_MANAGER: Permission[] = [
  ...TEAM_LEAD,
  'project:create',
  'project:delete',
  'meeting:manage',
  'approval:decide',
  'member:invite',
  'audit:read',
];

const ADMIN: Permission[] = ALL.filter(
  (p) => p !== 'org:delete' && p !== 'org:billing',
);

/** Guests only get what is explicitly shared; resource-level policy narrows further. */
const GUEST: Permission[] = ['workspace:read', 'project:read', 'task:read', 'comment:read', 'comment:create'];

export const ROLE_PERMISSIONS: Readonly<Record<RoleName, ReadonlySet<Permission>>> = {
  OWNER: new Set(ALL),
  ADMIN: new Set(ADMIN),
  PROJECT_MANAGER: new Set(PROJECT_MANAGER),
  TEAM_LEAD: new Set(TEAM_LEAD),
  DEVELOPER: new Set(DEVELOPER),
  VIEWER: new Set(READ_ONLY),
  GUEST: new Set(GUEST),
};

/** Higher number = more privileged. */
export const ROLE_RANK: Readonly<Record<RoleName, number>> = {
  OWNER: 100,
  ADMIN: 80,
  PROJECT_MANAGER: 60,
  TEAM_LEAD: 50,
  DEVELOPER: 40,
  VIEWER: 20,
  GUEST: 10,
};

export function isRoleName(value: string): value is RoleName {
  return (ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: RoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: RoleName): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/**
 * Role-assignment policy:
 *  - actor needs `member:role_update`
 *  - actor can never assign a role above their own rank
 *  - only an OWNER can assign or modify OWNER
 *  - actor cannot change the role of someone ranked at or above them (unless OWNER)
 */
export function canAssignRole(
  actor: RoleName,
  currentTargetRole: RoleName | null,
  newRole: RoleName,
): boolean {
  if (!hasPermission(actor, 'member:role_update')) return false;
  if (actor === 'OWNER') return true;
  if (newRole === 'OWNER' || currentTargetRole === 'OWNER') return false;
  if (ROLE_RANK[newRole] > ROLE_RANK[actor]) return false;
  if (currentTargetRole !== null && ROLE_RANK[currentTargetRole] >= ROLE_RANK[actor]) return false;
  return true;
}

/** Same rule for inviting: you can only invite up to (and not above) your own rank; OWNER is never invitable by non-owners. */
export function canInviteWithRole(actor: RoleName, invitedRole: RoleName): boolean {
  if (!hasPermission(actor, 'member:invite')) return false;
  if (actor === 'OWNER') return true;
  if (invitedRole === 'OWNER') return false;
  return ROLE_RANK[invitedRole] <= ROLE_RANK[actor];
}

/** Removing members: need `member:remove`; cannot remove someone at or above your rank unless OWNER. */
export function canRemoveMember(actor: RoleName, targetRole: RoleName): boolean {
  if (!hasPermission(actor, 'member:remove')) return false;
  if (actor === 'OWNER') return true;
  return ROLE_RANK[targetRole] < ROLE_RANK[actor];
}
