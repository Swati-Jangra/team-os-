'use client';
import Link from 'next/link';
import { CheckCircle2, Lock } from 'lucide-react';
import { Badge, Card, CardContent, EmptyState, ErrorState, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useOrgContext } from '@/features/org/org-context';
import { useMyTasks, useProjects } from '@/features/projects/api';
import { PRIORITY, TASK_STATUS, formatDay, isOverdue } from '@/features/projects/meta';

export default function MyTasksPage() {
  const { orgId } = useOrgContext();
  const mine = useMyTasks(orgId);
  const projects = useProjects(orgId);
  const pname = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? '';
  return (
    <>
      <PageHeader title="My tasks" description="Open tasks assigned to you, soonest due first." />
      <Card>
        <CardContent className="p-0">
          {mine.isPending ? (
            <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : mine.isError ? (
            <ErrorState message="Couldn't load your tasks." onRetry={() => mine.refetch()} />
          ) : mine.data.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="You’re all caught up" description="Tasks assigned to you will appear here." />
          ) : (
            <ul className="divide-y divide-border">
              {mine.data.map((t) => (
                <li key={t.id}>
                  <Link href={`/o/${orgId}/projects/${t.projectId}?task=${t.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
                    <span className="font-mono text-xs text-muted-foreground">{t.identifier}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
                    {t.openBlockers > 0 ? <Lock className="h-4 w-4 text-warning" aria-label="Blocked" /> : null}
                    <span className="hidden text-xs text-muted-foreground sm:inline">{pname(t.projectId)}</span>
                    <Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge>
                    <Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge>
                    <span className={isOverdue(t.dueDate, t.status) ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground'}>{t.dueDate ? formatDay(t.dueDate) : 'No due date'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
