'use client';
import { useState } from 'react';
import { Calendar, Mail, RefreshCw, Unplug } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Dialog, DialogContent, EmptyState, Field, Input, Select, Skeleton } from '@teamos/ui';
import { useProjects } from '@/features/projects/api';
import { useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { timeAgo } from '@/lib/labels';
import { useGoogle, useGoogleCalendars, useGoogleMutations, type GoogleIntegration } from './api';

const statusBadge = (i: GoogleIntegration) => <Badge tone={i.status === 'CONNECTED' ? 'success' : 'danger'}>{i.status === 'CONNECTED' ? 'Connected' : 'Needs reconnecting'}</Badge>;

function ConnectCalendarDialog({ integration, open, onOpenChange }: { integration: GoogleIntegration; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const cals = useGoogleCalendars(orgId, integration.id, open);
  const { connectCalendar } = useGoogleMutations(orgId);
  const [calendarId, setCalendarId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Connect a calendar" description="Its events (title, time, attendee count) are visible to members of the chosen workspace only. Event descriptions and attendee emails are not stored.">
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); await connectCalendar.mutateAsync({ integrationId: integration.id, calendarId, workspaceId }).then(() => { onOpenChange(false); setCalendarId(''); }, () => undefined); }}>
          <Field label="Calendar" htmlFor="gcal-id">
            {cals.isError ? <p role="alert" className="text-sm text-destructive">Couldn&apos;t load calendars. Try reconnecting Google.</p> : (
              <Select id="gcal-id" required value={calendarId} onChange={(e) => setCalendarId(e.target.value)} disabled={cals.isPending}>
                <option value="">{cals.isPending ? 'Loading…' : 'Choose a calendar'}</option>
                {(cals.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.primary ? ' (primary)' : ''}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Workspace" htmlFor="gcal-ws">
            <Select id="gcal-ws" required value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              <option value="">Choose a workspace</option>
              {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={connectCalendar.isPending} disabled={!calendarId || !workspaceId}>Connect calendar</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectMailboxDialog({ integration, open, onOpenChange }: { integration: GoogleIntegration; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const allProjects = useProjects(orgId);
  const { connectMailbox } = useGoogleMutations(orgId);
  const [workspaceId, setWorkspaceId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [label, setLabel] = useState('TeamOS');
  const projects = (allProjects.data ?? []).filter((p) => p.workspaceId === workspaceId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Connect a mailbox label" description="Only messages you label in Gmail with this label are read. Their text (up to 4,000 characters) is stored and analysed; nothing becomes a task until a person approves it.">
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); await connectMailbox.mutateAsync({ integrationId: integration.id, workspaceId, projectId: projectId || undefined, label }).then(() => onOpenChange(false), () => undefined); }}>
          <Field label="Gmail label" htmlFor="gm-label" hint="Create it in Gmail first, then apply it to the emails you want here.">
            <Input id="gm-label" required value={label} maxLength={100} pattern="[A-Za-z0-9 _\/\-]{1,100}" onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Workspace" htmlFor="gm-ws">
            <Select id="gm-ws" required value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setProjectId(''); }}>
              <option value="">Choose a workspace</option>
              {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label="Default project (optional)" htmlFor="gm-proj" hint="Used when a message does not mention a task key like APO-12.">
            <Select id="gm-proj" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!workspaceId}>
              <option value="">No default</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={connectMailbox.isPending} disabled={!workspaceId || !label}>Connect mailbox</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Google Calendar + Gmail cards for the Integrations page. */
export function GoogleCards() {
  const { orgId, can } = useOrgContext();
  const q = useGoogle(orgId);
  const m = useGoogleMutations(orgId);
  const workspaces = useWorkspaces(orgId);
  const [calDialog, setCalDialog] = useState(false);
  const [mailDialog, setMailDialog] = useState(false);
  const [confirm, setConfirm] = useState<GoogleIntegration | null>(null);
  const manage = can('integration:manage');
  if (q.isPending) return <Skeleton className="mt-6 h-40 w-full" />;
  if (q.isError) return null;
  const { configured, calendar, mail } = q.data;
  const wsName = (id: string) => workspaces.data?.find((w) => w.id === id)?.name ?? 'Workspace';
  const head = (icon: React.ReactNode, title: string, blurb: string, i: GoogleIntegration | null, kind: 'calendar' | 'mail') => (
    <div className="flex flex-wrap items-center gap-3 px-5 py-4">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground">{i ? `Connected as ${i.accountLogin}` : blurb}</p>
      </div>
      {i ? statusBadge(i) : null}
      {!configured ? <Badge tone="warning">Not configured on this server</Badge> : null}
      {manage && configured && (!i || i.status === 'ERROR') ? <Button loading={m.start.isPending && m.start.variables === kind} onClick={() => m.start.mutate(kind)}>{i ? 'Reconnect' : `Connect ${title}`}</Button> : null}
      {manage && i ? <Button variant="outline" onClick={() => setConfirm(i)}>Disconnect</Button> : null}
    </div>
  );
  return (
    <>
      <Card className="mt-6" data-testid="google-calendar-card">
        {head(<Calendar className="h-8 w-8" aria-hidden />, 'Google Calendar', 'Read-only access to the calendars you choose.', calendar.integration, 'calendar')}
        {calendar.integration?.lastError ? <p role="alert" className="border-t border-border px-5 py-3 text-sm text-destructive">{calendar.integration.lastError}</p> : null}
        {calendar.integration && calendar.integration.status === 'CONNECTED' ? (
          <div className="border-t border-border">
            <div className="flex items-center gap-3 px-5 py-3">
              <h3 className="flex-1 text-sm font-semibold">Calendars</h3>
              {manage ? <Button size="sm" onClick={() => setCalDialog(true)}>Connect calendar</Button> : null}
            </div>
            {calendar.sources.length === 0 ? <EmptyState icon={<Calendar className="h-5 w-5" />} title="No calendars connected" description="Choose a calendar and the workspace that may see its events." /> : (
              <ul>{calendar.sources.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3" data-testid="calendar-source">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{s.name}</p>
                    <p className="text-xs text-muted-foreground">{wsName(s.workspaceId)} · {s.lastSyncedAt ? `synced ${timeAgo(s.lastSyncedAt)}` : 'not synced yet'}</p>
                    {s.lastError ? <p role="alert" className="text-xs text-destructive">{s.lastError}</p> : null}
                  </div>
                  {manage ? <>
                    <Button size="sm" variant="outline" onClick={() => m.syncCalendar.mutate(s.id)}><RefreshCw className="h-4 w-4" aria-hidden /> Sync now</Button>
                    <Button size="sm" variant="ghost" aria-label={`Disconnect ${s.name}`} onClick={() => m.disconnectCalendar.mutate(s.id)}><Unplug className="h-4 w-4" aria-hidden /></Button>
                  </> : null}
                </li>
              ))}</ul>
            )}
          </div>
        ) : null}
      </Card>

      <Card className="mt-6" data-testid="google-mail-card">
        {head(<Mail className="h-8 w-8" aria-hidden />, 'Gmail', 'Reads only the messages you label.', mail.integration, 'mail')}
        {mail.integration?.lastError ? <p role="alert" className="border-t border-border px-5 py-3 text-sm text-destructive">{mail.integration.lastError}</p> : null}
        {mail.integration && mail.integration.status === 'CONNECTED' ? (
          <div className="border-t border-border">
            {mail.source ? (
              <div className="flex flex-wrap items-center gap-3 px-5 py-3" data-testid="mail-source">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Label “{mail.source.label}”</p>
                  <p className="text-xs text-muted-foreground">{wsName(mail.source.workspaceId)} · {mail.source.lastSyncedAt ? `synced ${timeAgo(mail.source.lastSyncedAt)}` : 'not synced yet'}</p>
                  {mail.source.lastError ? <p role="alert" className="text-xs text-destructive">{mail.source.lastError}</p> : null}
                </div>
                {manage ? <>
                  <Button size="sm" variant="outline" onClick={() => m.syncMailbox.mutate(mail.source!.id)}><RefreshCw className="h-4 w-4" aria-hidden /> Sync now</Button>
                  <Button size="sm" variant="ghost" aria-label="Disconnect mailbox label" onClick={() => m.disconnectMailbox.mutate(mail.source!.id)}><Unplug className="h-4 w-4" aria-hidden /></Button>
                </> : null}
              </div>
            ) : (
              <div className="flex items-center gap-3 px-5 py-3">
                <p className="flex-1 text-sm text-muted-foreground">No label connected yet.</p>
                {manage ? <Button size="sm" onClick={() => setMailDialog(true)}>Connect label</Button> : null}
              </div>
            )}
          </div>
        ) : null}
      </Card>

      {calendar.integration ? <ConnectCalendarDialog integration={calendar.integration} open={calDialog} onOpenChange={setCalDialog} /> : null}
      {mail.integration ? <ConnectMailboxDialog integration={mail.integration} open={mailDialog} onOpenChange={setMailDialog} /> : null}
      <ConfirmDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} title={`Disconnect ${confirm?.provider === 'GOOGLE_MAIL' ? 'Gmail' : 'Google Calendar'}?`}
        description="Syncing stops immediately, Google is told to revoke access and the stored credentials are deleted. Data already synced stays visible."
        confirmLabel="Disconnect" destructive loading={m.disconnect.isPending} onConfirm={() => confirm && m.disconnect.mutate(confirm.id, { onSuccess: () => setConfirm(null) })} />
    </>
  );
}
