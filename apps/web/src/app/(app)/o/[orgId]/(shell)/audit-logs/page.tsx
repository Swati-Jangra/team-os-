'use client';
import { useState } from 'react';
import { ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import { Avatar, Badge, Button, Card, CardContent, EmptyState, ErrorState, Select, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useAudit, useMembers } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { actionLabel, formatDate } from '@/lib/labels';

const FILTERS = [
  'org.created',
  'org.updated',
  'workspace.created',
  'workspace.updated',
  'workspace.deleted',
  'invitation.created',
  'invitation.accepted',
  'invitation.revoked',
  'member.role_changed',
  'member.removed',
];

/** Page 31 — Audit Logs (append-only; enforced in the database). */
export default function AuditLogsPage() {
  const { orgId, can } = useOrgContext();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const audit = useAudit(orgId, { page, pageSize: 20, action: action || undefined });
  const members = useMembers(orgId, can('member:read'));
  const nameById = new Map((members.data ?? []).map((m) => [m.userId, m.name]));

  return (
    <>
      <PageHeader title="Audit logs" description="A tamper-resistant record of who did what, and when." />
      <Card>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <Select
            aria-label="Filter by action"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
            className="w-full sm:w-64"
          >
            <option value="">All actions</option>
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {actionLabel(f)}
              </option>
            ))}
          </Select>
          {audit.data ? (
            <span className="text-sm text-muted-foreground">{audit.data.meta.total} events</span>
          ) : null}
        </div>
        <CardContent className="overflow-x-auto p-0 pb-2">
          {audit.isPending ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : audit.isError ? (
            <ErrorState message="Couldn't load audit logs." onRetry={() => audit.refetch()} />
          ) : audit.data.items.length === 0 ? (
            <EmptyState icon={<ScrollText className="h-5 w-5" />} title="No matching events" />
          ) : (
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pl-5 pr-3 font-medium">Event</th>
                  <th className="px-3 pb-2 font-medium">Actor</th>
                  <th className="px-3 pb-2 font-medium">When</th>
                  <th className="pb-2 pl-3 pr-5 font-medium">Request</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.items.map((a) => {
                  const actor = (a.actorId && nameById.get(a.actorId)) || (a.actorType === 'SYSTEM' ? 'System' : a.actorType === 'AI' ? 'AI agent' : 'Former member');
                  return (
                    <tr key={a.id} className="border-t border-border">
                      <td className="py-3 pl-5 pr-3">
                        <p className="font-medium">{actionLabel(a.action)}</p>
                        <p className="font-mono text-xs text-muted-foreground">{a.action}</p>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <Avatar name={actor} size="sm" />
                          <span className="truncate">{actor}</span>
                          {a.actorType !== 'USER' ? <Badge tone="primary">{a.actorType}</Badge> : null}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
                        <time dateTime={a.createdAt}>{formatDate(a.createdAt, true)}</time>
                      </td>
                      <td className="py-3 pl-3 pr-5 font-mono text-xs text-muted-foreground">
                        {a.requestId ? a.requestId.slice(0, 8) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
        {audit.data && audit.data.meta.totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-border p-3">
            <span className="text-sm text-muted-foreground">
              Page {audit.data.meta.page} of {audit.data.meta.totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= audit.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
