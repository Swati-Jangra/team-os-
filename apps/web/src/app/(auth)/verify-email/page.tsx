'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { AuthShell } from '@/features/auth/auth-shell';

type State = 'working' | 'ok' | 'failed';

function Verify() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<State>(token ? 'working' : 'failed');
  const [message, setMessage] = useState('This verification link is missing its token.');
  const started = useRef(false); // tokens are single-use: never submit twice (React strict mode re-runs effects)

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setState('ok'))
      .catch((e) => {
        setMessage(
          e instanceof ApiError && e.code === 'TOKEN_INVALID'
            ? 'This link is invalid, expired or has already been used. If you already verified, you can sign in.'
            : 'We could not verify your email right now. Please try again.',
        );
        setState('failed');
      });
  }, [token]);

  return (
    <AuthShell title="Email verification">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/50 p-8 text-center" role="status" aria-live="polite">
        {state === 'working' ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
            <p className="text-sm text-muted-foreground">Verifying your email…</p>
          </>
        ) : state === 'ok' ? (
          <>
            <CheckCircle2 className="h-8 w-8 text-success" aria-hidden />
            <p className="font-medium">Email verified</p>
            <p className="text-sm text-muted-foreground">Your account is ready. You can sign in now.</p>
          </>
        ) : (
          <>
            <XCircle className="h-8 w-8 text-destructive" aria-hidden />
            <p className="text-sm text-muted-foreground">{message}</p>
          </>
        )}
      </div>
      <Link href="/login" className="block text-center text-sm font-medium text-primary hover:underline">
        Go to sign in
      </Link>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
