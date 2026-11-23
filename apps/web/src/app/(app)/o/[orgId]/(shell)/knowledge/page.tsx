'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { FileText, Search, Sparkles } from 'lucide-react';
import { Badge, Button, Card, CardContent, EmptyState, Input, Select, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { useKnowledgeAsk, useKnowledgeSearch, type AskResult, type SearchHit } from '@/features/documents/api';

function SourceCard({ hit, n, cited }: { hit: SearchHit; n?: number; cited?: boolean }) {
  const { orgId } = useOrgContext();
  return (
    <li id={n ? `source-${n}` : undefined} className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        {n ? <Badge tone={cited ? 'primary' : 'neutral'}>[{n}]</Badge> : null}
        <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
        <Link href={`/o/${orgId}/documents/${hit.sourceId}`} className="font-medium hover:underline">{hit.title}</Link>
        {hit.heading ? <span className="text-sm text-muted-foreground">› {hit.heading}</span> : null}
        <span className="ml-auto flex gap-1">
          {hit.matched.keyword ? <Badge>Keyword</Badge> : null}
          {hit.matched.vector ? <Badge>Semantic</Badge> : null}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{hit.snippet}</p>
    </li>
  );
}

/** Renders "[2]" markers as links to the matching source card. */
function withCitations(text: string): ReactNode[] {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = /^\[(\d+)\]$/.exec(part);
    return m ? <a key={i} href={`#source-${m[1]}`} className="mx-0.5 rounded bg-primary-soft px-1 text-xs font-semibold text-primary no-underline">[{m[1]}]</a> : <span key={i}>{part}</span>;
  });
}

export default function KnowledgePage() {
  const { orgId, can } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const search = useKnowledgeSearch(orgId);
  const ask = useKnowledgeAsk(orgId);
  const [q, setQ] = useState('');
  const [ws, setWs] = useState('');
  const [mode, setMode] = useState<'search' | 'ask' | null>(null);
  const canAsk = can('ai:use');
  const initial = useSearchParams().get('q');
  const started = useRef(false);
  const valid = q.trim().length >= 3;
  const wsId = ws || undefined;

  const run = (m: 'search' | 'ask') => {
    if (!valid) return;
    setMode(m);
    if (m === 'search') search.mutate({ query: q.trim(), workspaceId: wsId });
    else ask.mutate({ question: q.trim(), workspaceId: wsId });
  };
  // arriving from the top-bar search: run it once
  useEffect(() => {
    if (initial && initial.trim().length >= 3 && !started.current) {
      started.current = true;
      setQ(initial);
      setMode('search');
      search.mutate({ query: initial.trim() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const answer: AskResult | undefined = mode === 'ask' ? ask.data : undefined;

  return (
    <>
      <PageHeader title="Knowledge search" description="Search your documents or ask a question. You only ever see content from workspaces you can access." />
      <Card>
        <CardContent className="space-y-3 pt-5">
          <form onSubmit={(e) => { e.preventDefault(); run(canAsk ? 'ask' : 'search'); }} className="flex flex-col gap-3 md:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input aria-label="Search or ask" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. When does the canary release start?" className="pl-9" maxLength={500} />
            </div>
            <Select aria-label="Workspace" className="md:w-48" value={ws} onChange={(e) => setWs(e.target.value)}>
              <option value="">All workspaces</option>
              {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={!valid} loading={search.isPending} onClick={() => run('search')}>Search</Button>
              {canAsk ? <Button type="button" disabled={!valid} loading={ask.isPending} onClick={() => run('ask')}><Sparkles className="h-4 w-4" aria-hidden /> Ask AI</Button> : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="mt-6 space-y-4" aria-live="polite">
        {mode === 'search' && search.isPending ? <Skeleton className="h-32 w-full" /> : null}
        {mode === 'search' && search.data ? (
          search.data.results.length === 0 ? (
            <Card><EmptyState icon={<Search className="h-5 w-5" />} title="No results" description="Try different words, or check that the document has been saved (indexing takes a few seconds)." /></Card>
          ) : (
            <ul className="space-y-3" aria-label="Search results">{search.data.results.map((h) => <SourceCard key={h.chunkId} hit={h} />)}</ul>
          )
        ) : null}

        {mode === 'ask' && ask.isPending ? <Skeleton className="h-40 w-full" /> : null}
        {answer ? (
          <>
            <Card>
              <CardContent className="space-y-3 pt-5">
                <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-primary" aria-hidden /> Answer</div>
                <p data-testid="answer" className="whitespace-pre-wrap leading-relaxed">{withCitations(answer.answer)}</p>
                {answer.provider === 'local' ? (
                  <p className="rounded-lg bg-warning/10 p-2 text-xs text-muted-foreground">
                    Offline demo mode: no language model is configured, so this answer is stitched together from the matching passages. Set <code>AI_PROVIDER=openai</code> for real answers.
                  </p>
                ) : null}
                {!answer.grounded && answer.sources.length > 0 ? <p className="text-xs text-muted-foreground">The answer does not cite any source — treat it with caution.</p> : null}
              </CardContent>
            </Card>
            {answer.sources.length > 0 ? (
              <>
                <h2 className="text-sm font-semibold">Sources</h2>
                <ul className="space-y-3" aria-label="Sources">{answer.sources.map((s) => <SourceCard key={s.chunkId} hit={s} n={s.n} cited={s.cited} />)}</ul>
              </>
            ) : null}
          </>
        ) : null}

        {mode === null ? (
          <Card><EmptyState icon={<Search className="h-5 w-5" />} title="Ask your knowledge base" description="Results link back to the documents they came from." /></Card>
        ) : null}
      </div>
    </>
  );
}
