'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck, ChevronLeft, ChevronRight } from 'lucide-react';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_META } from '@teamos/validation';
import { Button, Card, CardContent, CardHeader, EmptyState, ErrorState, Skeleton, cn } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useOrgContext } from '@/features/org/org-context';
import { timeAgo } from '@/lib/labels';
import { useNotificationMutations, useNotifications, usePreferences, type PreferenceDto } from '@/features/notifications/api';

/** Notification center: inbox + per-category delivery preferences. */
export default function NotificationsPage() {
  const { orgId } = useOrgContext();
  const [tab, setTab] = useState<'inbox' | 'prefs'>('inbox');
  return (
    <>
      <PageHeader title="Notifications" description="Updates about the work you’re involved in." />
      <div role="tablist" aria-label="Notifications" className="mb-4 inline-flex rounded-lg border border-border bg-card p-1">
        {(['inbox', 'prefs'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn('rounded-md px-4 py-1.5 text-sm font-medium', tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {t === 'inbox' ? 'Inbox' : 'Preferences'}
          </button>
        ))}
      </div>
      {tab === 'inbox' ? <Inbox orgId={orgId} /> : <Preferences orgId={orgId} />}
    </>
  );
}

function Inbox({ orgId }: { orgId: string }) {
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useNotifications(orgId, page, unreadOnly);
  const { markRead, markAllRead } = useNotificationMutations(orgId);
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 p-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => {
              setUnreadOnly(e.target.checked);
              setPage(1);
            }}
          />
          Unread only
        </label>
        <Button variant="outline" size="sm" className="ml-auto" loading={markAllRead.isPending} onClick={() => markAllRead.mutate()}>
          <CheckCheck className="h-4 w-4" aria-hidden /> Mark all read
        </Button>
      </div>
      <CardContent className="p-0">
        {q.isPending ? (
          <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : q.isError ? (
          <ErrorState message="Couldn't load notifications." onRetry={() => q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState icon={<Bell className="h-5 w-5" />} title={unreadOnly ? 'No unread notifications' : 'Nothing yet'} description="Assignments, comments and due dates will show up here." />
        ) : (
          <ul>
            {q.data.items.map((n) => (
              <li key={n.id} className={cn('flex items-start gap-3 border-t border-border px-5 py-3', !n.readAt && 'bg-primary-soft/40')}>
                <span aria-hidden className={cn('mt-2 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} />
                <div className="min-w-0 flex-1">
                  {n.link ? (
                    <Link href={n.link} onClick={() => !n.readAt && markRead.mutate(n.id)} className="font-medium hover:underline">
                      {n.title}
                    </Link>
                  ) : (
                    <p className="font-medium">{n.title}</p>
                  )}
                  {n.body ? <p className="text-sm text-muted-foreground">{n.body}</p> : null}
                  <time dateTime={n.createdAt} className="text-xs text-muted-foreground">
                    {NOTIFICATION_META[n.category].label} · {timeAgo(n.createdAt)}
                  </time>
                </div>
                {!n.readAt ? (
                  <Button variant="ghost" size="sm" onClick={() => markRead.mutate(n.id)}>
                    Mark read
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {q.data && q.data.meta.totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-border p-3">
          <span className="text-sm text-muted-foreground">
            Page {q.data.meta.page} of {q.data.meta.totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= q.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function Preferences({ orgId }: { orgId: string }) {
  const prefs = usePreferences();
  const { savePreferences } = useNotificationMutations(orgId);
  const [draft, setDraft] = useState<PreferenceDto[]>([]);
  useEffect(() => {
    if (prefs.data) setDraft(prefs.data);
  }, [prefs.data]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(prefs.data ?? []);
  const set = (category: string, field: 'inApp' | 'email', v: boolean) =>
    setDraft((d) => d.map((p) => (p.category === category ? { ...p, [field]: v } : p)));

  return (
    <Card className="max-w-3xl">
      <CardHeader title="Delivery" description="Choose how you’re told about each kind of update. These apply across all your organizations." />
      <CardContent>
        {prefs.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : prefs.isError ? (
          <ErrorState message="Couldn't load preferences." onRetry={() => prefs.refetch()} />
        ) : (
          <>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 font-medium">Category</th>
                  <th className="pb-2 text-center font-medium">In-app</th>
                  <th className="pb-2 text-center font-medium">Email</th>
                </tr>
              </thead>
              <tbody>
                {NOTIFICATION_CATEGORIES.map((c) => {
                  const p = draft.find((d) => d.category === c);
                  if (!p) return null;
                  return (
                    <tr key={c} className="border-t border-border">
                      <td className="py-3 pr-3">
                        <p className="font-medium">{NOTIFICATION_META[c].label}</p>
                        <p className="text-xs text-muted-foreground">{NOTIFICATION_META[c].description}</p>
                      </td>
                      <td className="text-center">
                        <input type="checkbox" aria-label={`${NOTIFICATION_META[c].label}: in-app`} checked={p.inApp} onChange={(e) => set(c, 'inApp', e.target.checked)} />
                      </td>
                      <td className="text-center">
                        <input type="checkbox" aria-label={`${NOTIFICATION_META[c].label}: email`} checked={p.email} onChange={(e) => set(c, 'email', e.target.checked)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Button className="mt-4" disabled={!dirty} loading={savePreferences.isPending} onClick={() => savePreferences.mutate(draft)}>
              Save preferences
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
