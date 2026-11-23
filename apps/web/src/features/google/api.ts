'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@teamos/ui';
import { api, apiPage } from '@/lib/api';
import { errorMessage } from '@/features/org/api';
import type { Priority } from '@/features/meetings/api';

export interface GoogleIntegration { id: string; provider: 'GOOGLE_CALENDAR' | 'GOOGLE_MAIL'; status: 'CONNECTED' | 'ERROR'; accountLogin: string; lastSyncedAt: string | null; lastError: string | null }
export interface CalendarSource { id: string; integrationId: string; workspaceId: string; calendarId: string; name: string; lastSyncedAt: string | null; lastError: string | null }
export interface MailSource { id: string; integrationId: string; workspaceId: string; projectId: string | null; label: string; lastSyncedAt: string | null; lastError: string | null }
export interface GoogleOverview {
  configured: boolean;
  calendar: { integration: GoogleIntegration | null; sources: CalendarSource[] };
  mail: { integration: GoogleIntegration | null; source: MailSource | null };
}
export interface CalendarEventDto { id: string; workspaceId: string; title: string; startsAt: string; endsAt: string; allDay: boolean; status: 'confirmed' | 'tentative'; htmlLink: string | null; attendeeCount: number; meetingId: string | null; conflict: boolean }
export interface EmailSummary { id: string; workspaceId: string; subject: string; fromAddress: string | null; receivedAt: string; status: 'RECEIVED' | 'EXTRACTED' | 'FAILED'; summary: string | null; projectId: string | null; linkSource: 'AUTO' | 'MANUAL' | null; projectKey: string | null; projectName: string | null; pendingItems: number }
export interface EmailItem { id: string; kind: 'DECISION' | 'ACTION_ITEM'; text: string; assigneeHint: string | null; dueDate: string | null; priority: Priority | null; status: 'PENDING' | 'APPROVED' | 'REJECTED'; taskId: string | null }
export interface EmailDetail extends EmailSummary { excerpt: string; failureReason: string | null; items: EmailItem[] }

const base = (o: string) => `/organizations/${o}`;
export const gk = {
  overview: (o: string) => ['org', o, 'google'] as const,
  events: (o: string, ws: string) => ['org', o, 'calendar', ws] as const,
  emails: (o: string, linked: string, page: number) => ['org', o, 'emails', 'list', linked, page] as const,
  email: (o: string, id: string) => ['org', o, 'emails', 'one', id] as const,
  allEmails: (o: string) => ['org', o, 'emails'] as const,
};

export const useGoogle = (orgId: string) => useQuery({ queryKey: gk.overview(orgId), queryFn: () => api<GoogleOverview>(`${base(orgId)}/google`) });
export const useGoogleCalendars = (orgId: string, integrationId: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: ['org', orgId, 'google', 'calendars', integrationId], enabled: enabled && !!integrationId, retry: false, queryFn: () => api<Array<{ id: string; name: string; primary: boolean }>>(`${base(orgId)}/google/${integrationId}/calendars`) });
export const useCalendarEvents = (orgId: string, workspaceId: string) =>
  useQuery({ queryKey: gk.events(orgId, workspaceId), queryFn: () => api<CalendarEventDto[]>(`${base(orgId)}/calendar/events?limit=100${workspaceId ? `&workspaceId=${workspaceId}` : ''}`) });
export const useEmails = (orgId: string, linked: string, page: number) =>
  useQuery({ queryKey: gk.emails(orgId, linked, page), placeholderData: keepPreviousData, queryFn: () => apiPage<EmailSummary>(`${base(orgId)}/emails?page=${page}&pageSize=20${linked ? `&linked=${linked}` : ''}`) });
export const useEmail = (orgId: string, id: string, enabled: boolean) =>
  useQuery({ queryKey: gk.email(orgId, id), enabled, queryFn: () => api<EmailDetail>(`${base(orgId)}/emails/${id}`) });

export function useGoogleMutations(orgId: string) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: gk.overview(orgId) });
  const onError = (e: unknown) => { toast.error(errorMessage(e)); refresh(); };
  return {
    start: useMutation({ mutationFn: (kind: 'calendar' | 'mail') => api<{ url: string }>(`${base(orgId)}/google/${kind}/authorize`, { method: 'POST', body: {} }), onSuccess: (r) => window.location.assign(r.url), onError }),
    disconnect: useMutation({ mutationFn: (id: string) => api(`${base(orgId)}/google/${id}`, { method: 'DELETE' }), onSuccess: () => { refresh(); toast.success('Disconnected. Syncing has stopped and the stored credentials were deleted.'); }, onError }),
    connectCalendar: useMutation({
      mutationFn: (v: { integrationId: string; calendarId: string; workspaceId: string }) => api(`${base(orgId)}/google/${v.integrationId}/calendar-sources`, { method: 'POST', body: { calendarId: v.calendarId, workspaceId: v.workspaceId } }),
      onSuccess: () => { refresh(); toast.success('Calendar connected. The first sync is running.'); }, onError,
    }),
    disconnectCalendar: useMutation({ mutationFn: (id: string) => api(`${base(orgId)}/google/calendar-sources/${id}`, { method: 'DELETE' }), onSuccess: () => { refresh(); toast.success('Calendar disconnected.'); }, onError }),
    syncCalendar: useMutation({ mutationFn: (id: string) => api(`${base(orgId)}/google/calendar-sources/${id}/sync`, { method: 'POST', body: {} }), onSuccess: () => toast.success('Sync requested.'), onError }),
    connectMailbox: useMutation({
      mutationFn: (v: { integrationId: string; workspaceId: string; projectId?: string; label: string }) =>
        api(`${base(orgId)}/google/${v.integrationId}/mailbox`, { method: 'POST', body: { workspaceId: v.workspaceId, label: v.label, ...(v.projectId ? { projectId: v.projectId } : {}) } }),
      onSuccess: () => { refresh(); toast.success('Mailbox connected. The first sync is running.'); }, onError,
    }),
    disconnectMailbox: useMutation({ mutationFn: (id: string) => api(`${base(orgId)}/google/mailboxes/${id}`, { method: 'DELETE' }), onSuccess: () => { refresh(); toast.success('Mailbox disconnected.'); }, onError }),
    syncMailbox: useMutation({ mutationFn: (id: string) => api(`${base(orgId)}/google/mailboxes/${id}/sync`, { method: 'POST', body: {} }), onSuccess: () => toast.success('Sync requested.'), onError }),
  };
}

export function useCalendarLinkMutations(orgId: string) {
  const qc = useQueryClient();
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['org', orgId, 'calendar'] }); void qc.invalidateQueries({ queryKey: ['org', orgId, 'meetings'] }); };
  return {
    link: useMutation({ mutationFn: (v: { meetingId: string; eventId: string }) => api(`${base(orgId)}/meetings/${v.meetingId}/calendar-event`, { method: 'POST', body: { eventId: v.eventId } }), onSuccess: () => { refresh(); toast.success('Meeting linked to the calendar event.'); }, onError: (e) => toast.error(errorMessage(e)) }),
    unlink: useMutation({ mutationFn: (meetingId: string) => api(`${base(orgId)}/meetings/${meetingId}/calendar-event`, { method: 'DELETE' }), onSuccess: refresh, onError: (e) => toast.error(errorMessage(e)) }),
  };
}

export function useEmailMutations(orgId: string) {
  const qc = useQueryClient();
  const refresh = (id?: string) => { void qc.invalidateQueries({ queryKey: gk.allEmails(orgId) }); if (id) void qc.invalidateQueries({ queryKey: gk.email(orgId, id) }); void qc.invalidateQueries({ queryKey: ['org', orgId, 'projects'] }); void qc.invalidateQueries({ queryKey: ['org', orgId, 'my-tasks'] }); };
  const onError = (e: unknown) => toast.error(errorMessage(e));
  return {
    linkProject: useMutation({ mutationFn: (v: { id: string; projectId: string | null }) => api(`${base(orgId)}/emails/${v.id}/project`, { method: 'PUT', body: { projectId: v.projectId } }), onSuccess: (_r, v) => refresh(v.id), onError }),
    editItem: useMutation({ mutationFn: (v: { id: string; itemId: string; text?: string; priority?: Priority | null }) => api(`${base(orgId)}/emails/${v.id}/items/${v.itemId}`, { method: 'PATCH', body: { ...(v.text ? { text: v.text } : {}), ...(v.priority !== undefined ? { priority: v.priority } : {}) } }), onSuccess: (_r, v) => refresh(v.id), onError }),
    approve: useMutation({
      mutationFn: (v: { id: string; itemId: string; projectId?: string }) => api<{ taskId: string | null }>(`${base(orgId)}/emails/${v.id}/items/${v.itemId}/approve`, { method: 'POST', body: v.projectId ? { projectId: v.projectId } : {} }),
      onSuccess: (r, v) => { refresh(v.id); toast.success(r.taskId ? 'Approved. A task was created.' : 'Approved and recorded.'); }, onError,
    }),
    reject: useMutation({ mutationFn: (v: { id: string; itemId: string }) => api(`${base(orgId)}/emails/${v.id}/items/${v.itemId}/reject`, { method: 'POST', body: {} }), onSuccess: (_r, v) => { refresh(v.id); toast.success('Rejected. Nothing was created.'); }, onError }),
  };
}
