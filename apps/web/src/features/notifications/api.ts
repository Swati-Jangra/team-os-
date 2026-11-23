'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@teamos/ui';
import type { NotificationCategoryName } from '@teamos/validation';
import { api, apiPage } from '@/lib/api';
import { errorMessage } from '@/features/org/api';

export interface NotificationDto {
  id: string;
  category: NotificationCategoryName;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}
export interface PreferenceDto {
  category: NotificationCategoryName;
  inApp: boolean;
  email: boolean;
}

export const nk = {
  all: (o: string) => ['org', o, 'notifications'] as const,
  list: (o: string, page: number, unread: boolean) => ['org', o, 'notifications', 'list', page, unread] as const,
  unread: (o: string) => ['org', o, 'notifications', 'unread'] as const,
  prefs: ['me', 'notification-preferences'] as const,
};
const base = (o: string) => `/organizations/${o}/notifications`;

export const useUnreadCount = (orgId: string) =>
  useQuery({ queryKey: nk.unread(orgId), queryFn: () => api<{ count: number }>(`${base(orgId)}/unread-count`), select: (d) => d.count });

export const useNotifications = (orgId: string, page: number, unread: boolean, pageSize = 20) =>
  useQuery({
    queryKey: nk.list(orgId, page, unread),
    queryFn: () => apiPage<NotificationDto>(`${base(orgId)}?page=${page}&pageSize=${pageSize}${unread ? '&unread=true' : ''}`),
    placeholderData: keepPreviousData,
  });

export const usePreferences = () => useQuery({ queryKey: nk.prefs, queryFn: () => api<PreferenceDto[]>('/me/notification-preferences') });

export function useNotificationMutations(orgId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: nk.all(orgId) });
  const onError = (e: unknown) => toast.error(errorMessage(e));
  return {
    markRead: useMutation({ mutationFn: (id: string) => api(`${base(orgId)}/${id}/read`, { method: 'POST', body: {} }), onSuccess: refresh, onError }),
    markAllRead: useMutation({ mutationFn: () => api(`${base(orgId)}/read-all`, { method: 'POST', body: {} }), onSuccess: refresh, onError }),
    savePreferences: useMutation({
      mutationFn: (preferences: PreferenceDto[]) => api<PreferenceDto[]>('/me/notification-preferences', { method: 'PUT', body: { preferences } }),
      onSuccess: (data) => {
        qc.setQueryData(nk.prefs, data);
        toast.success('Notification preferences saved');
      },
      onError,
    }),
  };
}
