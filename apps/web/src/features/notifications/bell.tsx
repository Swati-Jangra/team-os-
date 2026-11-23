'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck } from 'lucide-react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, cn } from '@teamos/ui';
import { useOrgContext } from '@/features/org/org-context';
import { timeAgo } from '@/lib/labels';
import { useNotificationMutations, useNotifications, useUnreadCount } from './api';

export function NotificationBell() {
  const { orgId } = useOrgContext();
  const router = useRouter();
  const unread = useUnreadCount(orgId);
  const list = useNotifications(orgId, 1, false, 8);
  const { markRead, markAllRead } = useNotificationMutations(orgId);
  const count = unread.data ?? 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={count ? `Notifications, ${count} unread` : 'Notifications'} className="relative">
          <Bell className="h-[18px] w-[18px]" />
          {count > 0 ? (
            <span
              data-testid="unread-badge"
              className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white"
            >
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-sm font-semibold">Notifications</p>
          <Button variant="ghost" size="sm" disabled={count === 0} loading={markAllRead.isPending} onClick={() => markAllRead.mutate()}>
            <CheckCheck className="h-4 w-4" aria-hidden /> Mark all read
          </Button>
        </div>
        <ul className="max-h-96 overflow-y-auto" aria-label="Recent notifications">
          {list.data?.items.length ? (
            list.data.items.map((n) => (
              <li key={n.id}>
                <button
                  className={cn('flex w-full items-start gap-2 border-b border-border px-3 py-2.5 text-left text-sm last:border-0 hover:bg-muted', !n.readAt && 'bg-primary-soft/40')}
                  onClick={() => {
                    if (!n.readAt) markRead.mutate(n.id);
                    if (n.link) router.push(n.link);
                  }}
                >
                  <span aria-hidden className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{n.title}</span>
                    {n.body ? <span className="block truncate text-xs text-muted-foreground">{n.body}</span> : null}
                    <time dateTime={n.createdAt} className="text-xs text-muted-foreground">
                      {timeAgo(n.createdAt)}
                    </time>
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-8 text-center text-sm text-muted-foreground">{list.isPending ? 'Loading…' : 'You’re all caught up.'}</li>
          )}
        </ul>
        <div className="border-t border-border p-2 text-center">
          <Link href={`/o/${orgId}/notifications`} className="text-sm font-medium text-primary hover:underline">
            View all &amp; preferences
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
