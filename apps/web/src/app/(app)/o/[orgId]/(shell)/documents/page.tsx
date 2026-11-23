'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronLeft, ChevronRight, FileText, Plus } from 'lucide-react';
import { createDocumentSchema } from '@teamos/validation';
import { Button, Card, Dialog, DialogContent, EmptyState, ErrorState, Field, Input, Select, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { useDocumentMutations, useDocuments } from '@/features/documents/api';
import { formatDate, timeAgo } from '@/lib/labels';

const formSchema = createDocumentSchema.pick({ workspaceId: true, title: true });
type FormValues = { workspaceId: string; title: string };

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrgContext();
  const router = useRouter();
  const workspaces = useWorkspaces(orgId);
  const { create } = useDocumentMutations(orgId);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({ resolver: zodResolver(formSchema) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New document" description="Documents are searchable by everyone who can see the workspace.">
        <form
          noValidate
          className="space-y-4"
          onSubmit={handleSubmit(async (v) => {
            const d = await create.mutateAsync(v);
            reset();
            onOpenChange(false);
            router.push(`/o/${orgId}/documents/${d.id}`);
          })}
        >
          <Field label="Workspace" htmlFor="d-ws" error={errors.workspaceId?.message}>
            <Select id="d-ws" defaultValue="" {...register('workspaceId')}>
              <option value="" disabled>Select a workspace…</option>
              {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label="Title" htmlFor="d-title" error={errors.title?.message}>
            <Input id="d-title" autoFocus {...register('title')} />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Create document</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Documents list (knowledge base source material). */
export default function DocumentsPage() {
  const { orgId, can } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const [ws, setWs] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const docs = useDocuments(orgId, ws, page);
  const wsName = (id: string) => workspaces.data?.find((w) => w.id === id)?.name ?? '';
  const canWrite = can('document:write');

  return (
    <>
      <PageHeader
        title="Documents"
        description="Write and share knowledge. Everything here is indexed for search and AI answers."
        actions={canWrite ? <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden /> New document</Button> : undefined}
      />
      <div className="mb-4">
        <Select aria-label="Filter by workspace" className="w-full sm:w-56" value={ws} onChange={(e) => { setWs(e.target.value); setPage(1); }}>
          <option value="">All workspaces</option>
          {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      </div>
      <Card>
        {docs.isPending ? (
          <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : docs.isError ? (
          <ErrorState message="Couldn't load documents." onRetry={() => docs.refetch()} />
        ) : docs.data.items.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-5 w-5" />}
            title="No documents yet"
            description={canWrite ? 'Create a document to build your team’s knowledge base.' : 'Documents you can access will show up here.'}
            action={canWrite ? <Button onClick={() => setOpen(true)}>New document</Button> : undefined}
          />
        ) : (
          <ul>
            {docs.data.items.map((d) => (
              <li key={d.id} className="border-t border-border first:border-t-0">
                <Link href={`/o/${orgId}/documents/${d.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                  <FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{d.title}</span>
                    <span className="block text-xs text-muted-foreground">{wsName(d.workspaceId)} · v{d.version}</span>
                  </span>
                  <time dateTime={d.updatedAt} title={formatDate(d.updatedAt, true)} className="shrink-0 text-xs text-muted-foreground">
                    {timeAgo(d.updatedAt)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {docs.data && docs.data.meta.totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-border p-3">
            <span className="text-sm text-muted-foreground">Page {docs.data.meta.page} of {docs.data.meta.totalPages}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" aria-hidden /> Previous</Button>
              <Button variant="outline" size="sm" disabled={page >= docs.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight className="h-4 w-4" aria-hidden /></Button>
            </div>
          </div>
        ) : null}
      </Card>
      {canWrite ? <CreateDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
