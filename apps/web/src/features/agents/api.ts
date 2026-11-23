'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@teamos/ui';
import { api, apiPage } from '@/lib/api';
import { errorMessage } from '@/features/org/api';

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export interface RiskFinding {
  kind: string;
  basis: 'FACT' | 'INFERRED';
  severity: RiskSeverity;
  taskId: string | null;
  identifier: string | null;
  message: string;
  recommendation: string;
  relatedTaskIds: string[];
  slipDays?: number;
}
export interface ProjectRisk {
  projectId: string;
  workspaceId: string;
  key: string;
  name: string;
  dueDate: string | null;
  counts: { high: number; medium: number; low: number };
  findings: RiskFinding[];
}
export type ActionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'EXECUTING' | 'EXECUTED' | 'FAILED' | 'STALE';
export interface AgentAction {
  id: string;
  workspaceId: string;
  projectId: string;
  agent: 'DEPENDENCY_RISK' | 'TASK_MANAGEMENT';
  actionType: 'TASK_UPDATE_DUE' | 'TASK_ASSIGN';
  targetTaskId: string;
  targetIdentifier: string | null;
  targetTitle: string | null;
  before: Record<string, string | null>;
  after: Record<string, string | null>;
  rationale: string;
  evidence: Array<{ basis: 'FACT' | 'INFERRED'; text: string }>;
  status: ActionStatus;
  proposedByName: string | null;
  expiresAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  attempts: number;
  lastError: string | null;
  executedAt: string | null;
  createdAt: string;
}

const base = (o: string) => `/organizations/${o}`;
export const ak = {
  risks: (o: string, ws: string) => ['org', o, 'risks', ws] as const,
  actions: (o: string, status: string, page: number) => ['org', o, 'agent-actions', status, page] as const,
  allActions: (o: string) => ['org', o, 'agent-actions'] as const,
};

export const useRisks = (orgId: string, workspaceId: string) =>
  useQuery({
    queryKey: ak.risks(orgId, workspaceId),
    queryFn: () => api<{ today: string; projects: ProjectRisk[] }>(`${base(orgId)}/risks${workspaceId ? `?workspaceId=${workspaceId}` : ''}`),
  });

export const useAgentActions = (orgId: string, status: string, page: number) =>
  useQuery({
    queryKey: ak.actions(orgId, status, page),
    queryFn: () => apiPage<AgentAction>(`${base(orgId)}/agent-actions?page=${page}&pageSize=20${status ? `&status=${status}` : ''}`),
    placeholderData: keepPreviousData,
  });

export function useAgentMutations(orgId: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ak.allActions(orgId) });
    void qc.invalidateQueries({ queryKey: ['org', orgId, 'risks'] });
    void qc.invalidateQueries({ queryKey: ['org', orgId, 'projects'] });
  };
  const onError = (e: unknown) => {
    toast.error(errorMessage(e));
    refresh();
  };
  const done = (a: AgentAction) => {
    refresh();
    if (a.status === 'EXECUTED') toast.success('Approved and applied.');
    else if (a.status === 'STALE') toast.warning('Not applied: the task changed after this was proposed.');
    else if (a.status === 'FAILED') toast.error(`Approved, but it could not be applied: ${a.lastError ?? 'unknown error'}`);
    else if (a.status === 'REJECTED') toast.success('Rejected. Nothing was changed.');
  };
  return {
    propose: useMutation({
      mutationFn: (projectId: string) => api<AgentAction[]>(`${base(orgId)}/projects/${projectId}/agent-proposals`, { method: 'POST', body: {} }),
      onSuccess: (r) => {
        refresh();
        toast.success(r.length ? `${r.length} proposal${r.length === 1 ? '' : 's'} are waiting for approval.` : 'No new proposals. Nothing to suggest right now.');
      },
      onError,
    }),
    approve: useMutation({
      mutationFn: ({ id, note }: { id: string; note?: string }) => api<AgentAction>(`${base(orgId)}/agent-actions/${id}/approve`, { method: 'POST', body: note ? { note } : {} }),
      onSuccess: done,
      onError,
    }),
    reject: useMutation({
      mutationFn: ({ id, note }: { id: string; note?: string }) => api<AgentAction>(`${base(orgId)}/agent-actions/${id}/reject`, { method: 'POST', body: note ? { note } : {} }),
      onSuccess: done,
      onError,
    }),
    retry: useMutation({
      mutationFn: (id: string) => api<AgentAction>(`${base(orgId)}/agent-actions/${id}/retry`, { method: 'POST' }),
      onSuccess: done,
      onError,
    }),
  };
}
