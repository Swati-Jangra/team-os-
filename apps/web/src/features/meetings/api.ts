'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@teamos/ui';
import { api, apiPage, apiUpload } from '@/lib/api';
import { errorMessage } from '@/features/org/api';

export type MeetingStatus = 'DRAFT' | 'PROCESSING' | 'READY' | 'FAILED';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export interface MeetingSummary {
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  heldAt: string | null;
  status: MeetingStatus;
  hasAudio: boolean;
  hasTranscript: boolean;
  summary: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface MeetingItem {
  id: string;
  kind: 'DECISION' | 'ACTION_ITEM' | 'BLOCKER';
  text: string;
  assigneeHint: string | null;
  dueDate: string | null;
  priority: Priority | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  taskId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}
export interface MeetingDto extends MeetingSummary {
  transcript: string | null;
  transcriptSource: 'PASTED' | 'AUDIO' | null;
  items: MeetingItem[];
}
export interface PlanTask {
  title: string;
  description?: string | null;
  priority?: Priority | null;
  estimateHours?: number | null;
  dependsOn: number[];
}

const base = (o: string) => `/organizations/${o}`;
export const mk = {
  all: (o: string) => ['org', o, 'meetings'] as const,
  list: (o: string, ws: string, page: number) => ['org', o, 'meetings', 'list', ws, page] as const,
  one: (o: string, id: string) => ['org', o, 'meeting', id] as const,
};

export const useMeetings = (orgId: string, workspaceId: string, page: number) =>
  useQuery({
    queryKey: mk.list(orgId, workspaceId, page),
    queryFn: () => apiPage<MeetingSummary>(`${base(orgId)}/meetings?page=${page}&pageSize=20${workspaceId ? `&workspaceId=${workspaceId}` : ''}`),
    placeholderData: keepPreviousData,
  });
export const useMeeting = (orgId: string, id: string) =>
  useQuery({ queryKey: mk.one(orgId, id), queryFn: () => api<MeetingDto>(`${base(orgId)}/meetings/${id}`) });

export function useMeetingMutations(orgId: string) {
  const qc = useQueryClient();
  const onError = (e: unknown) => toast.error(errorMessage(e));
  const refresh = (m?: { id: string }) => {
    void qc.invalidateQueries({ queryKey: mk.all(orgId) });
    if (m) void qc.invalidateQueries({ queryKey: mk.one(orgId, m.id) });
  };
  return {
    create: useMutation({
      mutationFn: (b: { workspaceId: string; title: string; projectId?: string | null; transcript?: string; audio?: File | null }) => {
        const { audio, ...rest } = b;
        return api<MeetingDto>(`${base(orgId)}/meetings`, { method: 'POST', body: rest }).then(async (m) => {
          if (!audio) return m;
          try {
            return await apiUpload<MeetingDto>(`${base(orgId)}/meetings/${m.id}/audio`, audio, audio.type || 'audio/mpeg');
          } catch (e) {
            toast.error(`Meeting created, but the audio upload failed: ${errorMessage(e)}`);
            return m;
          }
        });
      },
      onSuccess: refresh,
      onError,
    }),
    update: useMutation({
      mutationFn: ({ id, ...b }: { id: string; title?: string; projectId?: string | null; transcript?: string | null }) =>
        api<MeetingDto>(`${base(orgId)}/meetings/${id}`, { method: 'PATCH', body: b }),
      onSuccess: refresh,
      onError,
    }),
    uploadAudio: useMutation({
      mutationFn: ({ id, file }: { id: string; file: File }) => apiUpload<MeetingDto>(`${base(orgId)}/meetings/${id}/audio`, file, file.type || 'audio/mpeg'),
      onSuccess: refresh,
      onError,
    }),
    process: useMutation({
      mutationFn: (id: string) => api<MeetingDto>(`${base(orgId)}/meetings/${id}/process`, { method: 'POST' }),
      onSuccess: (m) => {
        refresh(m);
        toast.success('Processing started. This page updates when it finishes.');
      },
      onError,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`${base(orgId)}/meetings/${id}`, { method: 'DELETE' }),
      onSuccess: () => refresh(),
      onError,
    }),
    editItem: useMutation({
      mutationFn: ({ meetingId, itemId, ...b }: { meetingId: string; itemId: string; text?: string; dueDate?: string | null; priority?: Priority | null }) =>
        api<MeetingItem>(`${base(orgId)}/meetings/${meetingId}/items/${itemId}`, { method: 'PATCH', body: b }),
      onSuccess: (_i, v) => refresh({ id: v.meetingId }),
      onError,
    }),
    approve: useMutation({
      mutationFn: ({ meetingId, itemId, ...b }: { meetingId: string; itemId: string; projectId?: string; assigneeId?: string | null }) =>
        api<{ item: MeetingItem; taskId: string | null }>(`${base(orgId)}/meetings/${meetingId}/items/${itemId}/approve`, { method: 'POST', body: b }),
      onSuccess: (r, v) => {
        refresh({ id: v.meetingId });
        void qc.invalidateQueries({ queryKey: ['org', orgId, 'projects'] });
        toast.success(r.taskId ? 'Approved. Task created.' : 'Approved.');
      },
      onError: (e) => {
        onError(e);
        void qc.invalidateQueries({ queryKey: mk.all(orgId) });
      },
    }),
    reject: useMutation({
      mutationFn: ({ meetingId, itemId }: { meetingId: string; itemId: string }) =>
        api(`${base(orgId)}/meetings/${meetingId}/items/${itemId}/reject`, { method: 'POST' }),
      onSuccess: (_r, v) => refresh({ id: v.meetingId }),
      onError,
    }),
  };
}

export function usePlanMutations(orgId: string, projectId: string) {
  const qc = useQueryClient();
  return {
    propose: useMutation({
      mutationFn: (goal: string) => api<{ tasks: PlanTask[]; provider: string; model: string }>(`${base(orgId)}/projects/${projectId}/plan`, { method: 'POST', body: goal.trim() ? { goal } : {} }),
      onError: (e) => toast.error(errorMessage(e)),
    }),
    apply: useMutation({
      mutationFn: (tasks: PlanTask[]) => api<{ id: string }[]>(`${base(orgId)}/projects/${projectId}/plan/apply`, { method: 'POST', body: { tasks } }),
      onSuccess: (r) => {
        void qc.invalidateQueries({ queryKey: ['org', orgId, 'projects'] });
        toast.success(`${r.length} task${r.length === 1 ? '' : 's'} created`);
      },
      onError: (e) => toast.error(errorMessage(e)),
    }),
  };
}
