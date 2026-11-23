'use client';
import { Suspense, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@teamos/ui';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/session';
import { AuthShell, FormError } from '@/features/auth/auth-shell';

function Accept() {
  const router = useRouter();
  const qc = useQueryClient();
  const token = useSearchParams().get('token');
  const me = useMe();

  // Invitations are bound to the signed-in user's email, so sign in first and come back here.
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      const back = `/accept-invite?token=${encodeURIComponent(token ?? '')}`;
      router.replace(`/login?next=${encodeURIComponent(back)}`);
    }
  }, [me.error, router, token]);

  const accept = useMutation({
    mutationFn: () => api<{ organizationId: string }>('/invitations/accept', { method: 'POST', body: { token } }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('You’ve joined the organization.');
      router.replace(`/o/${res.organizationId}/dashboard`);
    },
  });

  if (!token) {
    return (
      <AuthShell title="Invitation not valid" subtitle="This invitation link is missing its token.">
        <Link href="/" className="text-sm font-medium text-primary hover:underline">
          Go home
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="You’ve been invited"
      subtitle={me.data ? `Joining as ${me.data.user.email}.` : 'Checking your session…'}
    >
      <FormError
        message={
          accept.error instanceof ApiError
            ? accept.error.code === 'INVITATION_INVALID'
              ? 'This invitation is invalid, expired, revoked, or was sent to a different email address. Make sure you are signed in with the invited address.'
              : accept.error.message
            : null
        }
      />
      <Button className="w-full" disabled={!me.data} loading={accept.isPending} onClick={() => accept.mutate()}>
        Accept invitation
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Wrong account?{' '}
        <Link href={`/login?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`} className="font-medium text-primary hover:underline">
          Sign in with another email
        </Link>
      </p>
    </AuthShell>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <Accept />
    </Suspense>
  );
}
