'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Check, ChevronLeft, Loader2, Upload, X } from 'lucide-react';
import { Badge, Button, Card, ErrorState, Input, Select, Skeleton, Textarea } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useWorkspaceMembers } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { useProjects } from '@/features/projects/api';
import { PRIORITIES, PRIORITY } from '@/features/projects/meta';
import { useMeeting, useMeetingMutations, type MeetingDto, type MeetingItem, type Priority } from '@/features/meetings/api';
import { MEETING_STATUS } from '@/features/meetings/meta';

const KIND = { DECISION: 'Decisions', ACTION_ITEM: 'Action items', BLOCKER: 'Blockers' } as const;

function ItemRow({ m, item, canDecide }: { m: MeetingDto; item: MeetingItem; canDecide: boolean }) {
  const { orgId } = useOrgContext();
  const { editItem, approve, reject } = useMeetingMutations(orgId);
  const projects = useProjects(orgId);
  const members = useWorkspaceMembers(orgId, m.workspaceId);
  const [text, setText] = useState(item.text);
  const [project, setProject] = useState(m.projectId ?? '');
  const [assignee, setAssignee] = useState('');
  const pending = item.status === 'PENDING';
  const wsProjects = (projects.data ?? []).filter((p) => p.workspaceId === m.workspaceId);
  const isAction = item.kind === 'ACTION_ITEM';
  const busy = approve.isPending || reject.isPending || editItem.isPending;

  return (
    <li className="space-y-2 border-t border-border px-5 py-3 first:border-t-0" data-testid="meeting-item">
      <div className="flex items-start gap-2">
        {pending && canDecide ? (
          <Input aria-label="Item text" value={text} onChange={(e) => setText(e.target.value)} maxLength={500}
            onBlur={() => { if (text.trim() && text !== item.text) editItem.mutate({ meetingId: m.id, itemId: item.id, text: text.trim() }); }} />
        ) : (
          <p className="flex-1 text-sm">{item.text}</p>
        )}
        {!pending ? <Badge tone={item.status === 'APPROVED' ? 'success' : 'neutral'}>{item.status === 'APPROVED' ? 'Approved' : 'Rejected'}</Badge> : <Badge tone="warning">Pending review</Badge>}
      </div>
      {isAction && (item.assigneeHint || item.dueDate || item.priority) ? (
        <p className="text-xs text-muted-foreground">
          {item.assigneeHint ? `Suggested owner: ${item.assigneeHint}` : ''}{item.dueDate ? ` · due ${item.dueDate}` : ''}{item.priority ? ` · ${PRIORITY[item.priority].label}` : ''}
        </p>
      ) : null}
      {item.taskId ? <p className="text-xs text-success">Task created from this item.</p> : null}
      {pending && canDecide ? (
        <div className="flex flex-wrap items-center gap-2">
          {isAction ? (
            <>
              <Select aria-label="Project for the new task" className="h-9 w-44" value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">Choose project…</option>
                {wsProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
              <Select aria-label="Assignee" className="h-9 w-40" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {(members.data ?? []).map((u) => <option key={u.userId} value={u.userId}>{u.name}</option>)}
              </Select>
              <Select aria-label="Priority" className="h-9 w-32" value={item.priority ?? ''}
                onChange={(e) => editItem.mutate({ meetingId: m.id, itemId: item.id, priority: (e.target.value || null) as Priority | null })}>
                <option value="">Priority</option>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}
              </Select>
            </>
          ) : null}
          <Button size="sm" disabled={busy || (isAction && !project)} loading={approve.isPending}
            onClick={() => approve.mutate({ meetingId: m.id, itemId: item.id, ...(isAction ? { projectId: project, assigneeId: assignee || null } : {}) })}>
            <Check className="h-4 w-4" aria-hidden /> {isAction ? 'Approve & create task' : 'Approve'}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate({ meetingId: m.id, itemId: item.id })}>
            <X className="h-4 w-4" aria-hidden /> Reject
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export default function MeetingDetailPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const { orgId, can } = useOrgContext();
  const router = useRouter();
  const meeting = useMeeting(orgId, meetingId);
  const { process, uploadAudio, update, remove } = useMeetingMutations(orgId);
  const [draft, setDraft] = useState<string | null>(null);
  const canManage = can('meeting:manage');
  const canDecide = can('approval:decide');

  if (meeting.isPending) return <Skeleton className="h-64 w-full" />;
  if (meeting.isError) return <ErrorState message="This meeting doesn't exist or you don't have access to it." onRetry={() => meeting.refetch()} />;
  const m = meeting.data;
  const st = MEETING_STATUS[m.status];
  const processing = m.status === 'PROCESSING';
  const transcript = draft ?? m.transcript ?? '';

  return (
    <>
      <Link href={`/o/${orgId}/meetings`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden /> Meetings</Link>
      <PageHeader
        title={m.title}
        description={m.transcriptSource ? `Transcript: ${m.transcriptSource === 'AUDIO' ? 'transcribed from audio' : 'pasted'}` : undefined}
        actions={
          <>
            <Badge tone={st.tone}>{processing ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}{st.label}</Badge>
            {canManage ? (
              <Button loading={process.isPending} disabled={processing || (!m.hasTranscript && !m.hasAudio)} onClick={() => process.mutate(m.id)}>
                {m.status === 'READY' ? 'Re-run extraction' : 'Process meeting'}
              </Button>
            ) : null}
            {canManage ? <Button variant="outline" onClick={async () => { if (confirm('Delete this meeting?')) { await remove.mutateAsync(m.id); router.push(`/o/${orgId}/meetings`); } }}>Delete</Button> : null}
          </>
        }
      />
      {m.status === 'FAILED' ? <p role="alert" className="mb-4 rounded-lg bg-danger-soft p-3 text-sm text-destructive">{m.failureReason ?? 'Processing failed.'}</p> : null}
      {m.summary ? (
        <Card className="mb-4 p-5"><h2 className="mb-1 text-sm font-semibold">Summary</h2><p className="whitespace-pre-wrap text-sm">{m.summary}</p>
          <p className="mt-2 text-xs text-muted-foreground">Generated by AI. Review before relying on it.</p></Card>
      ) : null}

      {(['DECISION', 'ACTION_ITEM', 'BLOCKER'] as const).map((k) => {
        const items = m.items.filter((i) => i.kind === k);
        if (!items.length) return null;
        return (
          <Card key={k} className="mb-4">
            <h2 className="px-5 pt-4 text-sm font-semibold">{KIND[k]}</h2>
            <ul className="mt-2">{items.map((i) => <ItemRow key={i.id} m={m} item={i} canDecide={canDecide} />)}</ul>
          </Card>
        );
      })}

      {canManage && m.status !== 'READY' ? (
        <Card className="mb-4 space-y-3 p-5">
          <h2 className="text-sm font-semibold">Source</h2>
          <Textarea aria-label="Transcript" rows={8} value={transcript} disabled={processing} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" disabled={processing || draft === null} loading={update.isPending}
              onClick={async () => { await update.mutateAsync({ id: m.id, transcript: draft }); setDraft(null); }}>Save transcript</Button>
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
              <Upload className="h-4 w-4" aria-hidden />
              <span>{m.hasAudio ? 'Replace audio' : 'Upload audio'}</span>
              <input type="file" accept="audio/*" className="sr-only" disabled={processing} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAudio.mutate({ id: m.id, file: f }); e.target.value = ''; }} />
            </label>
            {m.hasAudio ? <span className="text-xs text-muted-foreground">Audio attached</span> : null}
          </div>
        </Card>
      ) : m.transcript ? (
        <Card className="p-5"><h2 className="mb-2 text-sm font-semibold">Transcript</h2><pre className="max-h-96 overflow-auto whitespace-pre-wrap text-sm">{m.transcript}</pre></Card>
      ) : null}
    </>
  );
}
