'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { RoleName } from '@teamos/permissions';

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: RoleName;
}

export interface Me {
  user: { id: string; email: string; name: string };
  memberships: Membership[];
  csrfToken: string;
}

export const ME_KEY = ['me'] as const;

export function useMe() {
  return useQuery<Me, ApiError>({
    queryKey: ME_KEY,
    queryFn: () => api<Me>('/auth/me'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 30_000,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST', body: {} }),
    onSettled: () => {
      qc.clear();
      window.location.assign('/login');
    },
  });
}
