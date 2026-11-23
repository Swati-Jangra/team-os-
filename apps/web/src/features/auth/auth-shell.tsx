import type { ReactNode } from 'react';
import Link from 'next/link';
import { CheckCircle2, Sparkles } from 'lucide-react';

const POINTS = [
  'Projects, tasks and dependencies in one workspace',
  'Meetings, documents and decisions that stay connected',
  'AI that proposes — and humans approve',
];

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="grid min-h-screen lg:grid-cols-[1fr_minmax(420px,520px)]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-indigo-600 via-violet-600 to-purple-700 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
            <Sparkles className="h-5 w-5" aria-hidden />
          </span>
          TeamOS AI
        </div>
        <div className="max-w-md space-y-6">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            The operating system for AI-powered teams.
          </h1>
          <ul className="space-y-3 text-white/90">
            {POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-white/80" aria-hidden />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-white/60">Multi-tenant by design. Every action audited.</p>
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 left-10 h-80 w-80 rounded-full bg-fuchsia-400/20 blur-3xl" />
      </aside>

      <section className="flex items-center justify-center bg-card px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm space-y-6">
          <Link href="/" className="flex items-center gap-2 font-semibold lg:hidden">
            <Sparkles className="h-5 w-5 text-primary" aria-hidden /> TeamOS AI
          </Link>
          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
            {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
          {children}
          {footer ? <div className="text-center text-sm text-muted-foreground">{footer}</div> : null}
        </div>
      </section>
    </main>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

/** Only allow same-site relative redirects after login (prevents open-redirect abuse). */
export function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}
