'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useMe } from '@/lib/session';

const LAST_ORG_KEY = 'teamos-last-org';

/** Entry point: send the visitor to login, org setup, or their (last used) organization. */
export default function Home() {
  const router = useRouter();
  const me = useMe();

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      router.replace('/login');
      return;
    }
    if (!me.data) return;
    if (me.data.memberships.length === 0) {
      router.replace('/onboarding/organization');
      return;
    }
    let last: string | null = null;
    try {
      last = window.localStorage.getItem(LAST_ORG_KEY);
    } catch {
      /* storage unavailable */
    }
    const target = me.data.memberships.find((m) => m.organizationId === last) ?? me.data.memberships[0]!;
    router.replace(`/o/${target.organizationId}/dashboard`);
  }, [me.data, me.error, router]);

  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-label="Loading">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}
