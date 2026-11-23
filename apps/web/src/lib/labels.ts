import type { RoleName } from '@teamos/permissions';

export const ROLE_LABEL: Record<RoleName, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  PROJECT_MANAGER: 'Project Manager',
  TEAM_LEAD: 'Team Lead',
  DEVELOPER: 'Developer',
  VIEWER: 'Viewer',
  GUEST: 'Guest',
};

export const ROLE_TONE: Record<RoleName, 'primary' | 'success' | 'warning' | 'neutral'> = {
  OWNER: 'primary',
  ADMIN: 'primary',
  PROJECT_MANAGER: 'success',
  TEAM_LEAD: 'success',
  DEVELOPER: 'neutral',
  VIEWER: 'neutral',
  GUEST: 'warning',
};

const ACTION_LABEL: Record<string, string> = {
  'auth.registered': 'Account created',
  'auth.email_verified': 'Email verified',
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in attempt',
  'auth.account_locked': 'Account locked after failed sign-ins',
  'auth.logout': 'Signed out',
  'auth.password_reset_requested': 'Password reset requested',
  'auth.password_reset': 'Password reset',
  'org.created': 'Organization created',
  'org.updated': 'Organization updated',
  'workspace.created': 'Workspace created',
  'workspace.updated': 'Workspace updated',
  'workspace.deleted': 'Workspace deleted',
  'workspace.member_added': 'Workspace member added',
  'workspace.member_removed': 'Workspace member removed',
  'invitation.created': 'Invitation sent',
  'invitation.accepted': 'Invitation accepted',
  'invitation.revoked': 'Invitation revoked',
  'member.role_changed': 'Role changed',
  'member.removed': 'Member removed',
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

export function formatDate(value: string | Date, withTime = false): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleString(undefined, withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' });
}

export function timeAgo(value: string | Date): string {
  const secs = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : formatDate(value);
}
