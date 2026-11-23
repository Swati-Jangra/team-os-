'use client';
import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, ArrowRight, CheckCircle2, Circle, Layers, MailPlus, Users } from 'lucide-react';
import { Avatar, Badge, Card, CardContent, CardHeader, EmptyState, ErrorState, Skeleton, buttonVariants } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useAudit, useInvitations, useMembers, useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { useMe } from '@/lib/session';
import { actionLabel, ROLE_LABEL, ROLE_TONE, timeAgo } from '@/lib/labels';

function Kpi({
  label,
  value,
  icon,
  href,
  loading,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  href?: string;
  loading?: boolean;
}) {
  const body = (
    <Card className="p-5 transition-shadow hover:shadow-pop">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className="rounded-lg bg-primary-soft p-2 text-primary">{icon}</span>
      </div>
      {loading ? <Skeleton className="mt-3 h-8 w-16" /> : <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>}
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Buckets audit events into the last 14 days (client-side, from real data). */
function activityByDay(items: Array<{ createdAt: string }>) {
  const days: Array<{ day: string; events: number; key: string }> = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({ key: d.toDateString(), day: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), events: 0 });
  }
  for (const it of items) {
    const k = new Date(it.createdAt).toDateString();
    const bucket = days.find((d) => d.key === k);
    if (bucket) bucket.events++;
  }
  return days;
}

export default function DashboardPage() {
  const { orgId, can, orgName } = useOrgContext();
  const me = useMe();
  const workspaces = useWorkspaces(orgId);
  const members = useMembers(orgId, can('member:read'));
  const invitations = useInvitations(orgId, can('member:invite'));
  const audit = useAudit(orgId, { pageSize: 100 }, can('audit:read'));

  const pending = (invitations.data ?? []).filter(
    (i) => !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt).getTime() > Date.now(),
  );
  const nameById = new Map((members.data ?? []).map((m) => [m.userId, m.name]));
  const firstName = me.data?.user.name.split(' ')[0] ?? '';
  const weekAgo = Date.now() - 7 * 86_400_000;
  const weekEvents = (audit.data?.items ?? []).filter((a) => new Date(a.createdAt).getTime() >= weekAgo).length;

  const hasWorkspace = (workspaces.data?.length ?? 0) > 0;
  const hasTeammate = (members.data?.length ?? 0) > 1 || pending.length > 0;
  const checklist = [
    { done: true, label: 'Create your organization', href: undefined },
    { done: hasWorkspace, label: 'Create a workspace', href: `/o/${orgId}/workspaces`, need: can('workspace:create') },
    { done: hasTeammate, label: 'Invite a teammate', href: `/o/${orgId}/members`, need: can('member:invite') },
  ];
  const showChecklist = !(hasWorkspace && hasTeammate) && !workspaces.isPending && !members.isPending;

  return (
    <>
      <PageHeader
        title={`Welcome back${firstName ? `, ${firstName}` : ''} 👋`}
        description={`Here’s what’s happening in ${orgName}.`}
        actions={
          can('member:invite') ? (
            <Link href={`/o/${orgId}/members`} className={buttonVariants()}>
              <MailPlus className="h-4 w-4" aria-hidden /> Invite teammate
            </Link>
          ) : undefined
        }
      />

      <section aria-label="Overview" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Workspaces" value={workspaces.data?.length ?? 0} loading={workspaces.isPending} icon={<Layers className="h-4 w-4" />} href={`/o/${orgId}/workspaces`} />
        {can('member:read') ? (
          <Kpi label="Members" value={members.data?.length ?? 0} loading={members.isPending} icon={<Users className="h-4 w-4" />} href={`/o/${orgId}/members`} />
        ) : null}
        {can('member:invite') ? (
          <Kpi label="Pending invitations" value={pending.length} loading={invitations.isPending} icon={<MailPlus className="h-4 w-4" />} href={`/o/${orgId}/members`} />
        ) : null}
        {can('audit:read') ? (
          <Kpi label="Events this week" value={weekEvents} loading={audit.isPending} icon={<Activity className="h-4 w-4" />} href={`/o/${orgId}/audit-logs`} />
        ) : null}
      </section>

      {showChecklist ? (
        <Card className="mt-6">
          <CardHeader title="Get started" description="Finish setting up your organization." />
          <CardContent>
            <ul className="divide-y divide-border">
              {checklist.map((c) => (
                <li key={c.label} className="flex items-center gap-3 py-3">
                  {c.done ? (
                    <CheckCircle2 className="h-5 w-5 text-success" aria-label="Done" />
                  ) : (
                    <Circle className="h-5 w-5 text-muted-foreground" aria-label="To do" />
                  )}
                  <span className={c.done ? 'text-muted-foreground line-through' : 'font-medium'}>{c.label}</span>
                  {!c.done && c.href && c.need !== false ? (
                    <Link href={c.href} className="ml-auto flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                      Start <ArrowRight className="h-4 w-4" aria-hidden />
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {can('audit:read') ? (
          <Card className="lg:col-span-2">
            <CardHeader title="Organization activity" description="Audited events over the last 14 days." />
            <CardContent>
              {audit.isError ? (
                <ErrorState message="Couldn't load activity." onRetry={() => audit.refetch()} />
              ) : audit.isPending ? (
                <Skeleton className="h-56 w-full" />
              ) : (
                <div className="h-56 w-full" role="img" aria-label="Bar chart of audited events per day">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={activityByDay(audit.data.items)} margin={{ left: -20, right: 4, top: 8 }}>
                      <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={11} stroke="hsl(var(--muted-foreground))" interval={1} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip
                        cursor={{ fill: 'hsl(var(--muted))' }}
                        contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))' }}
                      />
                      <Bar dataKey="events" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        <Card className={can('audit:read') ? '' : 'lg:col-span-3'}>
          <CardHeader
            title="Workspaces"
            action={
              <Link href={`/o/${orgId}/workspaces`} className="text-sm font-medium text-primary hover:underline">
                View all
              </Link>
            }
          />
          <CardContent>
            {workspaces.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : workspaces.isError ? (
              <ErrorState message="Couldn't load workspaces." onRetry={() => workspaces.refetch()} />
            ) : workspaces.data.length === 0 ? (
              <EmptyState
                icon={<Layers className="h-5 w-5" />}
                title="No workspaces yet"
                description={can('workspace:create') ? 'Create a workspace to start organizing work.' : 'You haven’t been added to a workspace yet.'}
              />
            ) : (
              <ul className="space-y-2">
                {workspaces.data.slice(0, 5).map((w) => (
                  <li key={w.id}>
                    <Link
                      href={`/o/${orgId}/workspaces/${w.id}`}
                      className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted"
                    >
                      <Avatar name={w.name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{w.name}</span>
                        {w.description ? <span className="block truncate text-xs text-muted-foreground">{w.description}</span> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {can('audit:read') ? (
          <Card>
            <CardHeader title="Recent activity" />
            <CardContent>
              {audit.isPending ? (
                <div className="space-y-3">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : audit.isError ? (
                <ErrorState message="Couldn't load activity." onRetry={() => audit.refetch()} />
              ) : audit.data.items.length === 0 ? (
                <EmptyState icon={<Activity className="h-5 w-5" />} title="No activity yet" />
              ) : (
                <ul className="divide-y divide-border">
                  {audit.data.items.slice(0, 8).map((a) => (
                    <li key={a.id} className="flex items-center gap-3 py-2.5">
                      <Avatar name={(a.actorId && nameById.get(a.actorId)) || (a.actorType === 'SYSTEM' ? 'System' : 'User')} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{actionLabel(a.action)}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {(a.actorId && nameById.get(a.actorId)) || (a.actorType === 'SYSTEM' ? 'System' : 'Former member')}
                        </p>
                      </div>
                      <time className="shrink-0 text-xs text-muted-foreground" dateTime={a.createdAt}>
                        {timeAgo(a.createdAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}

        {can('member:read') ? (
          <Card>
            <CardHeader
              title="Team"
              action={
                <Link href={`/o/${orgId}/members`} className="text-sm font-medium text-primary hover:underline">
                  Manage
                </Link>
              }
            />
            <CardContent>
              {members.isPending ? (
                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : members.isError ? (
                <ErrorState message="Couldn't load members." onRetry={() => members.refetch()} />
              ) : (
                <ul className="divide-y divide-border">
                  {members.data.slice(0, 6).map((m) => (
                    <li key={m.userId} className="flex items-center gap-3 py-2.5">
                      <Avatar name={m.name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{m.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                      </div>
                      <Badge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
