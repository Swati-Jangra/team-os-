'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ShieldAlert, Sparkles } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Select, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { useAgentMutations, useRisks, type ProjectRisk } from '@/features/agents/api';
import { SEVERITY_TONE } from '@/features/agents/meta';

function ProjectCard({ p }: { p: ProjectRisk }) {
  const { orgId, can } = useOrgContext();
  const { propose } = useAgentMutations(orgId);
  return (
    <Card className="mb-4" data-testid="project-risk">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <Link href={`/o/${orgId}/projects/${p.projectId}`} className="font-semibold hover:underline">{p.name}</Link>
          <p className="text-xs text-muted-foreground">{p.key}{p.dueDate ? ` · due ${p.dueDate}` : ''}</p>
        </div>
        {p.counts.high ? <Badge tone="danger">{p.counts.high} high</Badge> : null}
        {p.counts.medium ? <Badge tone="warning">{p.counts.medium} medium</Badge> : null}
        {!p.findings.length ? <Badge tone="success">No risks found</Badge> : null}
        {can('ai:use') && p.findings.length ? (
          <Button size="sm" variant="outline" loading={propose.isPending && propose.variables === p.projectId} onClick={() => propose.mutate(p.projectId)}>
            <Sparkles className="h-4 w-4" aria-hidden /> Propose fixes
          </Button>
        ) : null}
      </div>
      {p.findings.length ? (
        <ul className="border-t border-border">
          {p.findings.map((f, i) => (
            <li key={i} className="space-y-1 border-t border-border px-5 py-3 first:border-t-0" data-testid="finding">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity.toLowerCase()}</Badge>
                <Badge tone={f.basis === 'FACT' ? 'primary' : 'neutral'}>{f.basis === 'FACT' ? 'Fact' : 'Inferred'}</Badge>
                <span className="text-sm">{f.message}</span>
              </div>
              <p className="text-xs text-muted-foreground">Suggestion: {f.recommendation}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export default function RiskCenterPage() {
  const { orgId } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const [ws, setWs] = useState('');
  const risks = useRisks(orgId, ws);
  return (
    <>
      <PageHeader title="Risk center" description="Schedule risks across your projects. “Fact” is true in your data today; “Inferred” is what that probably means for downstream work. Suggested changes always wait for a person's approval." />
      <div className="mb-4">
        <Select aria-label="Filter by workspace" className="w-full sm:w-56" value={ws} onChange={(e) => setWs(e.target.value)}>
          <option value="">All workspaces</option>
          {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      </div>
      {risks.isPending ? <Skeleton className="h-40 w-full" /> : risks.isError ? <ErrorState message="Couldn't analyse risks." onRetry={() => risks.refetch()} /> :
        risks.data.projects.length === 0 ? <Card><EmptyState icon={<ShieldAlert className="h-5 w-5" />} title="No active projects" description="Risks appear once projects have tasks with due dates and dependencies." /></Card> :
        risks.data.projects.map((p) => <ProjectCard key={p.projectId} p={p} />)}
    </>
  );
}
