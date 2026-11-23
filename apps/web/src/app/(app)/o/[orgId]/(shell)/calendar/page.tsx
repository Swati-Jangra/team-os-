'use client';
import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Calendar as CalendarIcon, ExternalLink, Link2, Unlink } from 'lucide-react';
import { Badge, Button, Card, Dialog, DialogContent, EmptyState, ErrorState, Field, Select, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useCalendarEvents, useCalendarLinkMutations, type CalendarEventDto } from '@/features/google/api';
import { useMeetings } from '@/features/meetings/api';
import { useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { safeUrl } from '@/features/integrations/meta';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const hm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function LinkMeetingDialog({ ev, open, onOpenChange }: { ev: CalendarEventDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrgContext();
  const meetings = useMeetings(orgId, ev.workspaceId, 1);
  const { link } = useCalendarLinkMutations(orgId);
  const [meetingId, setMeetingId] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Link to a meeting" description={`“${ev.title}” will be attached to the meeting record. If the meeting has no date yet, it takes this event's start time.`}>
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); await link.mutateAsync({ meetingId, eventId: ev.id }).then(() => onOpenChange(false), () => undefined); }}>
          <Field label="Meeting" htmlFor="lm-meeting">
            <Select id="lm-meeting" required value={meetingId} onChange={(e) => setMeetingId(e.target.value)} disabled={meetings.isPending}>
              <option value="">{meetings.isPending ? 'Loading…' : 'Choose a meeting'}</option>
              {(meetings.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={link.isPending} disabled={!meetingId}>Link meeting</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EventRow({ ev }: { ev: CalendarEventDto }) {
  const { orgId, can } = useOrgContext();
  const { unlink } = useCalendarLinkMutations(orgId);
  const [open, setOpen] = useState(false);
  const href = ev.htmlLink ? safeUrl(ev.htmlLink) : null;
  const manage = can('meeting:manage');
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3 first:border-t-0" data-testid="calendar-event">
      <span className="w-28 shrink-0 text-sm tabular-nums text-muted-foreground">{ev.allDay ? 'All day' : `${hm(ev.startsAt)} – ${hm(ev.endsAt)}`}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{ev.title}</p>
        <p className="text-xs text-muted-foreground">{ev.attendeeCount ? `${ev.attendeeCount} attendee${ev.attendeeCount === 1 ? '' : 's'}` : 'No attendees listed'}</p>
      </div>
      {ev.status === 'tentative' ? <Badge tone="neutral">Tentative</Badge> : null}
      {ev.conflict ? <Badge tone="warning"><AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden />Overlaps another event</Badge> : null}
      {ev.meetingId ? (
        <>
          <Link href={`/o/${orgId}/meetings/${ev.meetingId}`} className="text-sm text-primary hover:underline">Meeting notes</Link>
          {manage ? <Button size="sm" variant="ghost" aria-label={`Unlink ${ev.title} from its meeting`} onClick={() => unlink.mutate(ev.meetingId!)}><Unlink className="h-4 w-4" aria-hidden /></Button> : null}
        </>
      ) : manage ? <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Link2 className="h-4 w-4" aria-hidden /> Link meeting</Button> : null}
      {href ? <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${ev.title} in Google Calendar`} className="text-muted-foreground hover:text-foreground"><ExternalLink className="h-4 w-4" aria-hidden /></a> : null}
      {open ? <LinkMeetingDialog ev={ev} open={open} onOpenChange={setOpen} /> : null}
    </li>
  );
}

export default function CalendarPage() {
  const { orgId } = useOrgContext();
  const [ws, setWs] = useState('');
  const workspaces = useWorkspaces(orgId);
  const events = useCalendarEvents(orgId, ws);
  const days = new Map<string, CalendarEventDto[]>();
  for (const e of events.data ?? []) {
    const k = day(e.startsAt);
    days.set(k, [...(days.get(k) ?? []), e]);
  }
  return (
    <>
      <PageHeader title="Calendar" description="The next two weeks from your connected Google calendars. Overlaps are flagged so you can schedule around them." />
      <div className="mb-4 flex items-center gap-3">
        <Select aria-label="Workspace" className="w-56" value={ws} onChange={(e) => setWs(e.target.value)}>
          <option value="">All my workspaces</option>
          {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      </div>
      {events.isPending ? <Skeleton className="h-40 w-full" /> : events.isError ? <ErrorState message="Couldn't load the calendar." onRetry={() => events.refetch()} /> :
        days.size === 0 ? <Card><EmptyState icon={<CalendarIcon className="h-5 w-5" />} title="No upcoming events" description="Connect a calendar under Integrations, or there is nothing scheduled in the next two weeks." /></Card> :
        [...days.entries()].map(([d, list]) => (
          <Card key={d} className="mb-4">
            <h2 className="px-5 py-3 text-sm font-semibold">{d}</h2>
            <ul className="border-t border-border">{list.map((e) => <EventRow key={e.id} ev={e} />)}</ul>
          </Card>
        ))}
    </>
  );
}
