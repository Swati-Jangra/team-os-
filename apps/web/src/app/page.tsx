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

  if (me.isError && !(me.error instanceof ApiError && me.error.status === 401)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
        <section className="w-full max-w-md space-y-5 rounded-2xl border bg-card p-8 shadow-sm" aria-labelledby="service-error-title">
          <div className="space-y-2">
            <p className="text-sm font-medium text-primary">TeamOS AI</p>
            <h1 id="service-error-title" className="text-2xl font-semibold tracking-tight">
              TeamOS is temporarily unavailable
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              We couldn&apos;t connect to a required service. Please try again in a moment. If the problem continues, contact your administrator.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void me.refetch()}
            disabled={me.isFetching}
            className="inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {me.isFetching ? 'Trying again…' : 'Try again'}
          </button>
        </section>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-label="Loading">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}
