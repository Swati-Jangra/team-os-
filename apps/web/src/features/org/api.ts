'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@teamos/ui';
import type { RoleName } from '@teamos/permissions';
import { api, apiPage, ApiError, type ApiMeta } from '@/lib/api';

// Types mirror the API's JSON (dates are ISO strings on the wire).
type Role = RoleName;

export interface OrgDto {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  createdAt: string;
  role: Role;
}
export interface WorkspaceDto {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
}
export interface MemberDto {
  userId: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}
export interface InvitationDto {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface AuditDto {
  id: string;
  actorType: 'USER' | 'AI' | 'SYSTEM';
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

export const errorMessage = (e: unknown): string =>
  e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';

const key = {
  org: (o: string) => ['org', o] as const,
  workspaces: (o: string) => ['org', o, 'workspaces'] as const,
  workspace: (o: string, w: string) => ['org', o, 'workspaces', w] as const,
  wsMembers: (o: string, w: string) => ['org', o, 'workspaces', w, 'members'] as const,
  members: (o: string) => ['org', o, 'members'] as const,
  invitations: (o: string) => ['org', o, 'invitations'] as const,
  audit: (o: string, q: string) => ['org', o, 'audit', q] as const,
};

export const useOrg = (orgId: string) =>
  useQuery({ queryKey: key.org(orgId), queryFn: () => api<OrgDto>(`/organizations/${orgId}`) });

export const useWorkspaces = (orgId: string) =>
  useQuery({ queryKey: key.workspaces(orgId), queryFn: () => api<WorkspaceDto[]>(`/organizations/${orgId}/workspaces`) });

export const useWorkspace = (orgId: string, wsId: string) =>
  useQuery({
    queryKey: key.workspace(orgId, wsId),
    queryFn: () => api<WorkspaceDto>(`/organizations/${orgId}/workspaces/${wsId}`),
  });

export const useWorkspaceMembers = (orgId: string, wsId: string) =>
  useQuery({
    queryKey: key.wsMembers(orgId, wsId),
    queryFn: () => api<MemberDto[]>(`/organizations/${orgId}/workspaces/${wsId}/members`),
  });

export const useMembers = (orgId: string, enabled = true) =>
  useQuery({ queryKey: key.members(orgId), queryFn: () => api<MemberDto[]>(`/organizations/${orgId}/members`), enabled });

export const useInvitations = (orgId: string, enabled = true) =>
  useQuery({
    queryKey: key.invitations(orgId),
    queryFn: () => api<InvitationDto[]>(`/organizations/${orgId}/invitations`),
    enabled,
  });

export const useAudit = (
  orgId: string,
  q: { page?: number; pageSize?: number; action?: string },
  enabled = true,
) => {
  const qs = new URLSearchParams();
  qs.set('page', String(q.page ?? 1));
  qs.set('pageSize', String(q.pageSize ?? 20));
  if (q.action) qs.set('action', q.action);
  return useQuery<{ items: AuditDto[]; meta: ApiMeta }>({
    queryKey: key.audit(orgId, qs.toString()),
    queryFn: () => apiPage<AuditDto>(`/organizations/${orgId}/audit-logs?${qs}`),
    placeholderData: keepPreviousData,
    enabled,
  });
};

export function useOrgMutations(orgId: string) {
  const qc = useQueryClient();
  const refresh = (...keys: ReadonlyArray<readonly unknown[]>) =>
    Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
  const onError = (e: unknown) => toast.error(errorMessage(e));

  return {
    updateOrg: useMutation({
      mutationFn: (body: { name: string }) => api<OrgDto>(`/organizations/${orgId}`, { method: 'PATCH', body }),
      onSuccess: async () => {
        await refresh(key.org(orgId), ['me']);
        toast.success('Organization updated');
      },
      onError,
    }),
    createWorkspace: useMutation({
      mutationFn: (body: { name: string; description?: string }) =>
        api<WorkspaceDto>(`/organizations/${orgId}/workspaces`, { method: 'POST', body }),
      onSuccess: async () => {
        await refresh(key.workspaces(orgId), ['org', orgId, 'audit']);
        toast.success('Workspace created');
      },
      onError,
    }),
    updateWorkspace: useMutation({
      mutationFn: (v: { id: string; name?: string; description?: string | null }) => {
        const { id, ...body } = v;
        return api<WorkspaceDto>(`/organizations/${orgId}/workspaces/${id}`, { method: 'PATCH', body });
      },
      onSuccess: async () => {
        await refresh(key.workspaces(orgId));
        toast.success('Workspace updated');
      },
      onError,
    }),
    deleteWorkspace: useMutation({
      mutationFn: (id: string) => api(`/organizations/${orgId}/workspaces/${id}`, { method: 'DELETE' }),
      onSuccess: async () => {
        await refresh(key.workspaces(orgId));
        toast.success('Workspace deleted');
      },
      onError,
    }),
    addWorkspaceMember: useMutation({
      mutationFn: (v: { wsId: string; userId: string; role: Role }) =>
        api(`/organizations/${orgId}/workspaces/${v.wsId}/members`, {
          method: 'POST',
          body: { userId: v.userId, role: v.role },
        }),
      onSuccess: async (_d, v) => {
        await refresh(key.wsMembers(orgId, v.wsId));
        toast.success('Member added to workspace');
      },
      onError,
    }),
    removeWorkspaceMember: useMutation({
      mutationFn: (v: { wsId: string; userId: string }) =>
        api(`/organizations/${orgId}/workspaces/${v.wsId}/members/${v.userId}`, { method: 'DELETE' }),
      onSuccess: async (_d, v) => {
        await refresh(key.wsMembers(orgId, v.wsId));
        toast.success('Member removed from workspace');
      },
      onError,
    }),
    invite: useMutation({
      mutationFn: (body: { email: string; role: Role; workspaceIds?: string[] }) =>
        api(`/organizations/${orgId}/invitations`, { method: 'POST', body }),
      onSuccess: async (_d, v) => {
        await refresh(key.invitations(orgId));
        toast.success(`Invitation sent to ${v.email}`);
      },
      onError,
    }),
    revokeInvitation: useMutation({
      mutationFn: (id: string) => api(`/organizations/${orgId}/invitations/${id}`, { method: 'DELETE' }),
      onSuccess: async () => {
        await refresh(key.invitations(orgId));
        toast.success('Invitation revoked');
      },
      onError,
    }),
    changeRole: useMutation({
      mutationFn: (v: { userId: string; role: Role }) =>
        api(`/organizations/${orgId}/members/${v.userId}/role`, { method: 'PUT', body: { role: v.role } }),
      onSuccess: async () => {
        await refresh(key.members(orgId), ['me']);
        toast.success('Role updated');
      },
      onError,
    }),
    removeMember: useMutation({
      mutationFn: (userId: string) => api(`/organizations/${orgId}/members/${userId}`, { method: 'DELETE' }),
      onSuccess: async () => {
        await refresh(key.members(orgId));
        toast.success('Member removed');
      },
      onError,
    }),
  };
}
