'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Mic, Plus } from 'lucide-react';
import { Badge, Button, Card, Dialog, DialogContent, EmptyState, ErrorState, Field, Input, Select, Skeleton, Textarea } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { useMeetingMutations, useMeetings } from '@/features/meetings/api';
import { MEETING_STATUS } from '@/features/meetings/meta';
import { formatDate, timeAgo } from '@/lib/labels';

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrgContext();
  const router = useRouter();
  const workspaces = useWorkspaces(orgId);
  const { create } = useMeetingMutations(orgId);
  const [ws, setWs] = useState('');
  const [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [audio, setAudio] = useState<File | null>(null);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ws) return setErr('Select a workspace.');
    if (!title.trim()) return setErr('Title is required.');
    setErr('');
    const m = await create.mutateAsync({ workspaceId: ws, title: title.trim(), transcript: transcript.trim() || undefined, audio });
    setTitle(''); setTranscript(''); setAudio(null);
    onOpenChange(false);
    router.push(`/o/${orgId}/meetings/${m.id}`);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New meeting" description="Paste a transcript or upload a recording. You review everything the AI extracts before it becomes work.">
        <form noValidate className="space-y-4" onSubmit={submit}>
          <Field label="Workspace" htmlFor="m-ws">
            <Select id="m-ws" value={ws} onChange={(e) => setWs(e.target.value)}>
              <option value="" disabled>Select a workspace…</option>
              {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label="Title" htmlFor="m-title">
            <Input id="m-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Transcript (optional)" htmlFor="m-tr" hint="Lines like “Decision: …”, “Action: …” and “Blocker: …” are understood best by the offline provider.">
            <Textarea id="m-tr" rows={5} value={transcript} onChange={(e) => setTranscript(e.target.value)} />
          </Field>
          <Field label="Audio recording (optional)" htmlFor="m-audio" hint="mp3, wav, m4a, webm or ogg, up to 25 MB.">
            <Input id="m-audio" type="file" accept="audio/*" onChange={(e) => setAudio(e.target.files?.[0] ?? null)} />
          </Field>
          {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Create meeting</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function MeetingsPage() {
  const { orgId, can } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const [ws, setWs] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const meetings = useMeetings(orgId, ws, page);
  const canManage = can('meeting:manage');
  const wsName = (id: string) => workspaces.data?.find((w) => w.id === id)?.name ?? '';

  return (
    <>
      <PageHeader
        title="Meetings"
        description="Turn transcripts into decisions, action items and blockers, then approve what becomes real work."
        actions={canManage ? <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden /> New meeting</Button> : undefined}
      />
      <div className="mb-4">
        <Select aria-label="Filter by workspace" className="w-full sm:w-56" value={ws} onChange={(e) => { setWs(e.target.value); setPage(1); }}>
          <option value="">All workspaces</option>
          {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      </div>
      <Card>
        {meetings.isPending ? (
          <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : meetings.isError ? (
          <ErrorState message="Couldn't load meetings." onRetry={() => meetings.refetch()} />
        ) : meetings.data.items.length === 0 ? (
          <EmptyState
            icon={<Mic className="h-5 w-5" />}
            title="No meetings yet"
            description={canManage ? 'Add a meeting with a transcript or recording to extract decisions and action items.' : 'Meetings you can access will show up here.'}
            action={canManage ? <Button onClick={() => setOpen(true)}>New meeting</Button> : undefined}
          />
        ) : (
          <ul>
            {meetings.data.items.map((m) => (
              <li key={m.id} className="border-t border-border first:border-t-0">
                <Link href={`/o/${orgId}/meetings/${m.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                  <Mic className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.title}</span>
                    <span className="block text-xs text-muted-foreground">{wsName(m.workspaceId)}{m.hasAudio ? ' · audio' : ''}{m.hasTranscript ? ' · transcript' : ''}</span>
                  </span>
                  <Badge tone={MEETING_STATUS[m.status].tone}>{MEETING_STATUS[m.status].label}</Badge>
                  <time dateTime={m.updatedAt} title={formatDate(m.updatedAt, true)} className="hidden shrink-0 text-xs text-muted-foreground sm:block">{timeAgo(m.updatedAt)}</time>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {meetings.data && meetings.data.meta.totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-border p-3">
            <span className="text-sm text-muted-foreground">Page {meetings.data.meta.page} of {meetings.data.meta.totalPages}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" aria-hidden /> Previous</Button>
              <Button variant="outline" size="sm" disabled={page >= meetings.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight className="h-4 w-4" aria-hidden /></Button>
            </div>
          </div>
        ) : null}
      </Card>
      {canManage ? <CreateDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
