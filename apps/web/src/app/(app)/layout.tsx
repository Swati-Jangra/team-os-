'use client';
import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { ErrorState } from '@teamos/ui';
import { ApiError } from '@/lib/api';
import { useMe } from '@/lib/session';

/** Everything under (app) needs a valid session; unauthenticated visitors are sent to login and returned afterwards. */
export default function AppGroupLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    if (unauthenticated) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [unauthenticated, router, pathname]);

  if (me.isPending || unauthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status" aria-label="Loading">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <ErrorState message="We couldn't load your account." onRetry={() => me.refetch()} />
      </div>
    );
  }
  return <>{children}</>;
}
