'use client';
import { useEffect, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { OrgProvider } from '@/features/org/org-context';
import { useMe } from '@/lib/session';

/** Validates that the URL's org is one the user belongs to (the API re-checks on every call). */
export default function OrgLayout({ children }: { children: ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>();
  const router = useRouter();
  const me = useMe();
  const membership = me.data?.memberships.find((m) => m.organizationId === orgId);

  useEffect(() => {
    if (me.data && !membership) router.replace('/');
    if (membership) {
      try {
        window.localStorage.setItem('teamos-last-org', orgId);
      } catch {
        /* storage unavailable */
      }
    }
  }, [me.data, membership, orgId, router]);

  if (!me.data || !membership) return null;
  return (
    <OrgProvider
      value={{ orgId, orgName: membership.organizationName, role: membership.role, userId: me.data.user.id }}
    >
      {children}
    </OrgProvider>
  );
}
