'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@teamos/ui';
import { api, apiPage } from '@/lib/api';
import { errorMessage } from '@/features/org/api';

export type IntegrationStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
export interface IntegrationDto {
  id: string;
  provider: 'GITHUB';
  status: IntegrationStatus;
  accountLogin: string;
  scopes: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}
export interface RepoDto {
  id: string;
  workspaceId: string;
  projectId: string | null;
  fullName: string;
  webhookActive: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}
export interface IntegrationsOverview {
  configured: boolean;
  integration: IntegrationDto | null;
  repos: RepoDto[];
}
export interface ExternalItemDto {
  id: string;
  workspaceId: string;
  kind: 'PULL_REQUEST' | 'ISSUE' | 'COMMIT';
  externalId: string;
  title: string;
  state: 'open' | 'closed' | 'merged' | null;
  url: string;
  authorLogin: string | null;
  updatedExtAt: string | null;
  tasks: Array<{ id: string; identifier: string }>;
}
export interface TaskLinkDto {
  linkId: string;
  source: 'AUTO' | 'MANUAL';
  itemId: string;
  kind: ExternalItemDto['kind'];
  externalId: string;
  title: string;
  state: ExternalItemDto['state'];
  url: string;
  authorLogin: string | null;
}

const base = (o: string) => `/organizations/${o}`;
export const ik = {
  overview: (o: string) => ['org', o, 'integrations'] as const,
  items: (o: string, kind: string, page: number) => ['org', o, 'integrations', 'items', kind, page] as const,
  links: (o: string, t: string) => ['org', o, 'task', t, 'links'] as const,
};

export const useIntegrations = (orgId: string) =>
  useQuery({ queryKey: ik.overview(orgId), queryFn: () => api<IntegrationsOverview>(`${base(orgId)}/integrations`) });

export const useExternalItems = (orgId: string, kind: string, page: number, enabled: boolean) =>
  useQuery({
    queryKey: ik.items(orgId, kind, page),
    enabled,
    queryFn: () => apiPage<ExternalItemDto>(`${base(orgId)}/external-items?page=${page}&pageSize=20${kind ? `&kind=${kind}` : ''}`),
    placeholderData: keepPreviousData,
  });

export const useAvailableRepos = (orgId: string, integrationId: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['org', orgId, 'integrations', 'available', integrationId],
    enabled: enabled && !!integrationId,
    queryFn: () => api<Array<{ fullName: string; private: boolean }>>(`${base(orgId)}/integrations/${integrationId}/available-repos`),
    retry: false,
  });

export function useIntegrationMutations(orgId: string) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ik.overview(orgId) });
  const onError = (e: unknown) => {
    toast.error(errorMessage(e));
    refresh();
  };
  return {
    startGitHub: useMutation({
      mutationFn: () => api<{ url: string }>(`${base(orgId)}/integrations/github/authorize`, { method: 'POST', body: {} }),
      onSuccess: (r) => window.location.assign(r.url), // GitHub shows its own consent screen; it returns to /integrations/github/callback
      onError,
    }),
    disconnect: useMutation({
      mutationFn: (id: string) => api(`${base(orgId)}/integrations/${id}`, { method: 'DELETE' }),
      onSuccess: () => { refresh(); toast.success('GitHub disconnected. Syncing has stopped and the token was deleted.'); },
      onError,
    }),
    connectRepo: useMutation({
      mutationFn: (v: { integrationId: string; fullName: string; workspaceId: string; projectId?: string }) =>
        api<RepoDto>(`${base(orgId)}/integrations/${v.integrationId}/repos`, { method: 'POST', body: { fullName: v.fullName, workspaceId: v.workspaceId, ...(v.projectId ? { projectId: v.projectId } : {}) } }),
      onSuccess: () => { refresh(); toast.success('Repository connected. The first sync is running.'); },
      onError,
    }),
    disconnectRepo: useMutation({
      mutationFn: (id: string) => api(`${base(orgId)}/integration-repos/${id}`, { method: 'DELETE' }),
      onSuccess: () => { refresh(); toast.success('Repository disconnected.'); },
      onError,
    }),
    syncRepo: useMutation({
      mutationFn: (id: string) => api(`${base(orgId)}/integration-repos/${id}/sync`, { method: 'POST', body: {} }),
      onSuccess: () => toast.success('Sync requested.'),
      onError,
    }),
  };
}

export const useTaskLinks = (orgId: string, taskId: string) =>
  useQuery({ queryKey: ik.links(orgId, taskId), queryFn: () => api<TaskLinkDto[]>(`${base(orgId)}/tasks/${taskId}/links`) });

export function useLinkMutations(orgId: string, taskId: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ik.links(orgId, taskId) });
    void qc.invalidateQueries({ queryKey: ['org', orgId, 'integrations', 'items'] });
  };
  return {
    link: useMutation({ mutationFn: (itemId: string) => api(`${base(orgId)}/tasks/${taskId}/links`, { method: 'POST', body: { itemId } }), onSuccess: refresh, onError: (e) => toast.error(errorMessage(e)) }),
    unlink: useMutation({ mutationFn: (linkId: string) => api(`${base(orgId)}/tasks/${taskId}/links/${linkId}`, { method: 'DELETE' }), onSuccess: refresh, onError: (e) => toast.error(errorMessage(e)) }),
  };
}
