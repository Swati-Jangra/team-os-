'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@teamos/ui';
import { api, apiPage, ApiError } from '@/lib/api';
import { errorMessage } from '@/features/org/api';

export interface DocumentSummary {
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface DocumentDto extends DocumentSummary {
  contentHtml: string;
}
export interface VersionSummary {
  version: number;
  title: string;
  createdBy: string;
  createdAt: string;
}
export interface SearchHit {
  chunkId: string;
  sourceType: 'DOCUMENT' | 'MEETING';
  sourceId: string;
  workspaceId: string;
  title: string;
  heading: string | null;
  snippet: string;
  score: number;
  matched: { keyword: boolean; vector: boolean };
}
export interface AskResult {
  answer: string;
  grounded: boolean;
  sources: (SearchHit & { n: number; cited: boolean })[];
  provider: string;
  model: string;
}

export const dk = {
  all: (o: string) => ['org', o, 'documents'] as const,
  list: (o: string, ws: string, page: number) => ['org', o, 'documents', 'list', ws, page] as const,
  doc: (o: string, id: string) => ['org', o, 'document', id] as const,
  versions: (o: string, id: string) => ['org', o, 'document', id, 'versions'] as const,
  version: (o: string, id: string, v: number) => ['org', o, 'document', id, 'versions', v] as const,
};
const base = (o: string) => `/organizations/${o}`;

export const useDocuments = (orgId: string, workspaceId: string, page: number) =>
  useQuery({
    queryKey: dk.list(orgId, workspaceId, page),
    queryFn: () => apiPage<DocumentSummary>(`${base(orgId)}/documents?page=${page}&pageSize=20${workspaceId ? `&workspaceId=${workspaceId}` : ''}`),
    placeholderData: keepPreviousData,
  });
export const useDocument = (orgId: string, id: string) =>
  useQuery({ queryKey: dk.doc(orgId, id), queryFn: () => api<DocumentDto>(`${base(orgId)}/documents/${id}`), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
export const useVersions = (orgId: string, id: string) =>
  useQuery({ queryKey: dk.versions(orgId, id), queryFn: () => api<VersionSummary[]>(`${base(orgId)}/documents/${id}/versions`) });
export const useVersion = (orgId: string, id: string, v: number | null) =>
  useQuery({ queryKey: dk.version(orgId, id, v ?? 0), queryFn: () => api<VersionSummary & { contentHtml: string }>(`${base(orgId)}/documents/${id}/versions/${v}`), enabled: v !== null });

export function useDocumentMutations(orgId: string) {
  const qc = useQueryClient();
  const onError = (e: unknown) => toast.error(errorMessage(e));
  return {
    create: useMutation({
      mutationFn: (b: { workspaceId: string; title: string; contentHtml?: string }) => api<DocumentDto>(`${base(orgId)}/documents`, { method: 'POST', body: b }),
      onSuccess: () => qc.invalidateQueries({ queryKey: dk.all(orgId) }),
      onError,
    }),
    update: useMutation({
      mutationFn: ({ id, ...b }: { id: string; title?: string; contentHtml?: string; expectedVersion: number }) =>
        api<DocumentDto>(`${base(orgId)}/documents/${id}`, { method: 'PATCH', body: b }),
      onSuccess: (d) => {
        qc.setQueryData(dk.doc(orgId, d.id), d);
        void qc.invalidateQueries({ queryKey: dk.all(orgId) });
        void qc.invalidateQueries({ queryKey: dk.versions(orgId, d.id) });
      },
      // a 409 is handled by the page (stale edit banner), not a generic toast
      onError: (e) => {
        if (!(e instanceof ApiError && e.status === 409)) onError(e);
      },
    }),
    restore: useMutation({
      mutationFn: ({ id, version, expectedVersion }: { id: string; version: number; expectedVersion: number }) =>
        api<DocumentDto>(`${base(orgId)}/documents/${id}/versions/${version}/restore`, { method: 'POST', body: { expectedVersion } }),
      onSuccess: (d) => {
        qc.setQueryData(dk.doc(orgId, d.id), d);
        void qc.invalidateQueries({ queryKey: dk.all(orgId) });
        void qc.invalidateQueries({ queryKey: dk.versions(orgId, d.id) });
        toast.success('Version restored as a new version');
      },
      onError,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`${base(orgId)}/documents/${id}`, { method: 'DELETE' }),
      onSuccess: () => qc.invalidateQueries({ queryKey: dk.all(orgId) }),
      onError,
    }),
  };
}

export const useKnowledgeSearch = (orgId: string) =>
  useMutation({
    mutationFn: (b: { query: string; workspaceId?: string }) => api<{ results: SearchHit[] }>(`${base(orgId)}/knowledge/search`, { method: 'POST', body: b }),
    onError: (e) => toast.error(errorMessage(e)),
  });
export const useKnowledgeAsk = (orgId: string) =>
  useMutation({
    mutationFn: (b: { question: string; workspaceId?: string }) => api<AskResult>(`${base(orgId)}/knowledge/ask`, { method: 'POST', body: b }),
    onError: (e) => toast.error(errorMessage(e)),
  });
