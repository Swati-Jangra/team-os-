import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  canAssignRole,
  canInviteWithRole,
  canRemoveMember,
  hasPermission,
  permissionsFor,
} from './index';

describe('role matrix', () => {
  it('OWNER has every permission', () => {
    for (const p of PERMISSIONS) expect(hasPermission('OWNER', p)).toBe(true);
  });

  it('ADMIN has everything except org deletion and billing', () => {
    expect(hasPermission('ADMIN', 'org:delete')).toBe(false);
    expect(hasPermission('ADMIN', 'org:billing')).toBe(false);
    expect(hasPermission('ADMIN', 'role:manage')).toBe(true);
    expect(hasPermission('ADMIN', 'audit:read')).toBe(true);
  });

  it('VIEWER is read-only', () => {
    const writes = permissionsFor('VIEWER').filter((p) => !p.endsWith(':read'));
    expect(writes).toEqual([]);
  });

  it('GUEST cannot see members, audit or org settings', () => {
    expect(hasPermission('GUEST', 'member:read')).toBe(false);
    expect(hasPermission('GUEST', 'audit:read')).toBe(false);
    expect(hasPermission('GUEST', 'org:read')).toBe(false);
  });

  it('only privileged roles can decide agent approvals', () => {
    const deciders = ROLES.filter((r) => hasPermission(r, 'approval:decide'));
    expect(deciders.sort()).toEqual(['ADMIN', 'OWNER', 'PROJECT_MANAGER']);
  });

  it('each role is a superset chain: DEVELOPER ⊂ TEAM_LEAD ⊂ PROJECT_MANAGER ⊂ ADMIN ⊂ OWNER', () => {
    const chain = ['DEVELOPER', 'TEAM_LEAD', 'PROJECT_MANAGER', 'ADMIN', 'OWNER'] as const;
    for (let i = 0; i < chain.length - 1; i++) {
      const lower = permissionsFor(chain[i]!);
      for (const p of lower) expect(hasPermission(chain[i + 1]!, p)).toBe(true);
    }
  });
});

describe('role assignment policy', () => {
  it('prevents self-escalation to OWNER by non-owners', () => {
    expect(canAssignRole('ADMIN', 'ADMIN', 'OWNER')).toBe(false);
    expect(canAssignRole('ADMIN', 'DEVELOPER', 'OWNER')).toBe(false);
  });

  it('admin cannot modify an owner or a peer admin', () => {
    expect(canAssignRole('ADMIN', 'OWNER', 'VIEWER')).toBe(false);
    expect(canAssignRole('ADMIN', 'ADMIN', 'VIEWER')).toBe(false);
  });

  it('admin can promote a lower-ranked member up to their own rank, never above', () => {
    expect(canAssignRole('ADMIN', 'DEVELOPER', 'PROJECT_MANAGER')).toBe(true);
    // equal rank is allowed (consistent with invitations); OWNER is not
    expect(canAssignRole('ADMIN', 'DEVELOPER', 'ADMIN')).toBe(true);
    expect(canAssignRole('ADMIN', 'DEVELOPER', 'OWNER')).toBe(false);
  });

  it('roles without member:role_update cannot assign anything', () => {
    expect(canAssignRole('PROJECT_MANAGER', 'VIEWER', 'GUEST')).toBe(false);
    expect(canAssignRole('DEVELOPER', 'VIEWER', 'GUEST')).toBe(false);
  });

  it('owner can assign any role', () => {
    for (const r of ROLES) expect(canAssignRole('OWNER', 'DEVELOPER', r)).toBe(true);
  });
});

describe('invite / remove policy', () => {
  it('project manager can invite at or below their rank, never above', () => {
    expect(canInviteWithRole('PROJECT_MANAGER', 'DEVELOPER')).toBe(true);
    expect(canInviteWithRole('PROJECT_MANAGER', 'PROJECT_MANAGER')).toBe(true);
    expect(canInviteWithRole('PROJECT_MANAGER', 'ADMIN')).toBe(false);
    expect(canInviteWithRole('PROJECT_MANAGER', 'OWNER')).toBe(false);
  });

  it('developers cannot invite', () => {
    expect(canInviteWithRole('DEVELOPER', 'VIEWER')).toBe(false);
  });

  it('admin can remove lower roles but not owner or peers', () => {
    expect(canRemoveMember('ADMIN', 'DEVELOPER')).toBe(true);
    expect(canRemoveMember('ADMIN', 'ADMIN')).toBe(false);
    expect(canRemoveMember('ADMIN', 'OWNER')).toBe(false);
    expect(canRemoveMember('OWNER', 'ADMIN')).toBe(true);
  });
});
