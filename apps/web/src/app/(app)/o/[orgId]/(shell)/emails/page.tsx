'use client';
import { useState } from 'react';
import { CheckCircle2, Mail, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Select, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useEmail, useEmailMutations, useEmails, type EmailItem, type EmailSummary } from '@/features/google/api';
import { useProjects } from '@/features/projects/api';
import { useOrgContext } from '@/features/org/org-context';
import { timeAgo } from '@/lib/labels';

function ItemRow({ messageId, item, defaultProject, workspaceId }: { messageId: string; item: EmailItem; defaultProject: string | null; workspaceId: string }) {
  const { orgId, can } = useOrgContext();
  const { approve, reject, editItem } = useEmailMutations(orgId);
  const projects = useProjects(orgId);
  const options = (projects.data ?? []).filter((p) => p.workspaceId === workspaceId);
  const [project, setProject] = useState(defaultProject ?? '');
  const [text, setText] = useState(item.text);
  const pending = item.status === 'PENDING';
  const canDecide = can('approval:decide');
  const action = item.kind === 'ACTION_ITEM';
  const busy = approve.isPending || reject.isPending;
  return (
    <li className="space-y-2 border-t border-border px-5 py-3 first:border-t-0" data-testid="email-item">
      <div className="flex items-start gap-2">
        <Badge tone="neutral">{action ? 'Action item' : 'Decision'}</Badge>
        {pending && canDecide ? <Input aria-label="Item text" className="h-9 flex-1" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} onBlur={() => { if (text.trim() && text !== item.text) editItem.mutate({ id: messageId, itemId: item.id, text: text.trim() }); }} /> : <p className="flex-1 text-sm">{item.text}</p>}
        <Badge tone={pending ? 'warning' : item.status === 'APPROVED' ? 'success' : 'neutral'}>{pending ? 'Pending review' : item.status === 'APPROVED' ? 'Approved' : 'Rejected'}</Badge>
      </div>
      {action && item.assigneeHint ? <p className="text-xs text-muted-foreground">Suggested owner: {item.assigneeHint}{item.dueDate ? ` · due ${item.dueDate}` : ''}</p> : null}
      {item.taskId ? <p className="text-xs text-success">Task created from this item.</p> : null}
      {pending && canDecide ? (
        <div className="flex flex-wrap items-center gap-2">
          {action ? (
            <Select aria-label="Project for the new task" className="h-9 w-56" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Choose a project…</option>
              {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          ) : null}
          <Button size="sm" disabled={busy || (action && !project)} loading={approve.isPending && approve.variables?.itemId === item.id} onClick={() => approve.mutate({ id: messageId, itemId: item.id, ...(action ? { projectId: project } : {}) })}><CheckCircle2 className="h-4 w-4" aria-hidden /> {action ? 'Approve & create task' : 'Approve'}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate({ id: messageId, itemId: item.id })}><X className="h-4 w-4" aria-hidden /> Reject</Button>
        </div>
      ) : null}
    </li>
  );
}

function Detail({ m }: { m: EmailSummary }) {
  const { orgId, can } = useOrgContext();
  const d = useEmail(orgId, m.id, true);
  const projects = useProjects(orgId);
  const { linkProject } = useEmailMutations(orgId);
  if (d.isPending) return <Skeleton className="m-5 h-24" />;
  if (d.isError) return <ErrorState message="Couldn't load this email." onRetry={() => d.refetch()} />;
  const mail = d.data;
  const options = (projects.data ?? []).filter((p) => p.workspaceId === mail.workspaceId);
  return (
    <div className="border-t border-border">
      <div className="space-y-2 px-5 py-4">
        {mail.summary ? <p className="text-sm"><span className="font-medium">Summary: </span>{mail.summary}</p> : null}
        <p className="whitespace-pre-wrap rounded-lg bg-muted p-3 text-sm" data-testid="email-excerpt">{mail.excerpt || '(no readable text)'}</p>
        {mail.failureReason ? <p role="alert" className="text-xs text-destructive">{mail.failureReason}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`proj-${mail.id}`} className="text-sm text-muted-foreground">Project</label>
          <Select id={`proj-${mail.id}`} className="h-9 w-56" disabled={!can('task:create')} value={mail.projectId ?? ''} onChange={(e) => linkProject.mutate({ id: mail.id, projectId: e.target.value || null })}>
            <option value="">Not linked</option>
            {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          {mail.linkSource ? <Badge tone="neutral">{mail.linkSource === 'AUTO' ? 'Linked automatically' : 'Linked by a person'}</Badge> : null}
        </div>
      </div>
      {mail.items.length ? <ul className="border-t border-border">{mail.items.map((i) => <ItemRow key={i.id} messageId={mail.id} item={i} defaultProject={mail.projectId} workspaceId={mail.workspaceId} />)}</ul> : <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">No decisions or action items were found in this message.</p>}
    </div>
  );
}

export default function EmailsPage() {
  const { orgId } = useOrgContext();
  const [linked, setLinked] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const emails = useEmails(orgId, linked, page);
  return (
    <>
      <PageHeader title="Email" description="Messages you labelled in Gmail. The AI proposes decisions and action items; nothing becomes a task until a person approves it." />
      <div className="mb-4 flex items-center gap-3">
        <Select aria-label="Filter" className="w-52" value={linked} onChange={(e) => { setLinked(e.target.value); setPage(1); }}>
          <option value="">All messages</option><option value="true">Linked to a project</option><option value="false">Not linked</option>
        </Select>
      </div>
      {emails.isPending ? <Skeleton className="h-40 w-full" /> : emails.isError ? <ErrorState message="Couldn't load email." onRetry={() => emails.refetch()} /> :
        emails.data.items.length === 0 ? <Card><EmptyState icon={<Mail className="h-5 w-5" />} title="No email yet" description="Connect Gmail under Integrations, then apply your label to a message." /></Card> :
        emails.data.items.map((m) => (
          <Card key={m.id} className="mb-3" data-testid="email-message">
            <button type="button" className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left" aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{m.subject}</p>
                <p className="text-xs text-muted-foreground">{m.fromAddress ?? 'Unknown sender'} · <time dateTime={m.receivedAt}>{timeAgo(m.receivedAt)}</time></p>
              </div>
              {m.projectKey ? <Badge tone="primary">{m.projectKey}</Badge> : <Badge tone="neutral">No project</Badge>}
              {m.pendingItems ? <Badge tone="warning">{m.pendingItems} to review</Badge> : null}
              {m.status === 'FAILED' ? <Badge tone="danger">Not analysed</Badge> : null}
            </button>
            {open === m.id ? <Detail m={m} /> : null}
          </Card>
        ))}
      {emails.data && emails.data.meta.totalPages > 1 ? (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Page {emails.data.meta.page} of {emails.data.meta.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= emails.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
