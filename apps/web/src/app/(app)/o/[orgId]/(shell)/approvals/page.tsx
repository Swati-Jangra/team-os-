'use client';
import { useState } from 'react';
import { CheckCircle2, ClipboardCheck, RotateCw, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useOrgContext } from '@/features/org/org-context';
import { useAgentActions, useAgentMutations, type AgentAction } from '@/features/agents/api';
import { ACTION_STATUS, ACTION_TITLE, AGENT_LABEL, FILTERS } from '@/features/agents/meta';
import { formatDate, timeAgo } from '@/lib/labels';

const show = (a: AgentAction, side: 'before' | 'after') =>
  a.actionType === 'TASK_UPDATE_DUE' ? (a[side].dueDate ?? 'No date') : (a[side].assigneeName ?? 'Unassigned');

function ActionCard({ a }: { a: AgentAction }) {
  const { orgId, can } = useOrgContext();
  const { approve, reject, retry } = useAgentMutations(orgId);
  const [note, setNote] = useState('');
  const st = ACTION_STATUS[a.status];
  const busy = approve.isPending || reject.isPending || retry.isPending;
  const canDecide = can('approval:decide');
  return (
    <Card className="mb-3 space-y-3 p-5" data-testid="agent-action">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{ACTION_TITLE[a.actionType]}</span>
        <span className="text-sm text-muted-foreground">{a.targetIdentifier} · {a.targetTitle}</span>
        <Badge tone={st.tone} className="ml-auto">{st.label}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted p-3 text-sm" aria-label="Proposed change">
        <span className="text-muted-foreground">Before</span><strong>{show(a, 'before')}</strong>
        <span aria-hidden>→</span>
        <span className="text-muted-foreground">After</span><strong>{show(a, 'after')}</strong>
      </div>
      <p className="text-sm">{a.rationale}</p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {a.evidence.map((e, i) => <li key={i}><Badge tone={e.basis === 'FACT' ? 'primary' : 'neutral'} className="mr-1">{e.basis === 'FACT' ? 'Fact' : 'Inferred'}</Badge>{e.text}</li>)}
      </ul>
      <p className="text-xs text-muted-foreground">
        {AGENT_LABEL[a.agent]} · requested by {a.proposedByName ?? 'someone'} · <time dateTime={a.createdAt} title={formatDate(a.createdAt, true)}>{timeAgo(a.createdAt)}</time>
        {a.status === 'PENDING' ? ` · expires ${formatDate(a.expiresAt)}` : ''}
        {a.decidedByName ? ` · decided by ${a.decidedByName}` : ''}{a.decisionNote ? ` (“${a.decisionNote}”)` : ''}
      </p>
      {a.lastError ? <p role="alert" className="text-xs text-destructive">{a.lastError}</p> : null}
      {canDecide && a.status === 'PENDING' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Note (optional)" placeholder="Note (optional)" className="h-9 w-56" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" disabled={busy} loading={approve.isPending} onClick={() => approve.mutate({ id: a.id, note: note || undefined })}><CheckCircle2 className="h-4 w-4" aria-hidden /> Approve</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate({ id: a.id, note: note || undefined })}><X className="h-4 w-4" aria-hidden /> Reject</Button>
        </div>
      ) : null}
      {canDecide && a.status === 'FAILED' ? (
        <Button size="sm" variant="outline" disabled={busy} loading={retry.isPending} onClick={() => retry.mutate(a.id)}><RotateCw className="h-4 w-4" aria-hidden /> Retry ({a.attempts} attempt{a.attempts === 1 ? '' : 's'} so far)</Button>
      ) : null}
    </Card>
  );
}

export default function ApprovalCenterPage() {
  const { orgId } = useOrgContext();
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const actions = useAgentActions(orgId, status, page);
  return (
    <>
      <PageHeader title="Approval center" description="AI agents only propose. Nothing changes until someone with approval rights approves it, and an approval only applies if the task is still exactly as the agent saw it." />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <Button key={f.value || 'all'} size="sm" variant={status === f.value ? 'default' : 'outline'} role="tab" aria-selected={status === f.value} onClick={() => { setStatus(f.value); setPage(1); }}>{f.label}</Button>
        ))}
      </div>
      {actions.isPending ? <Skeleton className="h-40 w-full" /> : actions.isError ? <ErrorState message="Couldn't load approvals." onRetry={() => actions.refetch()} /> :
        actions.data.items.length === 0 ? <Card><EmptyState icon={<ClipboardCheck className="h-5 w-5" />} title="Nothing here" description="Ask the agents for suggestions from the Risk center." /></Card> :
        actions.data.items.map((a) => <ActionCard key={a.id} a={a} />)}
      {actions.data && actions.data.meta.totalPages > 1 ? (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Page {actions.data.meta.page} of {actions.data.meta.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= actions.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
