'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, History, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, ConfirmDialog, ErrorState, Input, Skeleton, cn } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { RichEditor } from '@/features/documents/editor';
import { useDocument, useDocumentMutations, useVersion, useVersions } from '@/features/documents/api';
import { useOrgContext } from '@/features/org/org-context';
import { ApiError } from '@/lib/api';
import { formatDate } from '@/lib/labels';

export default function DocumentPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const { orgId, can } = useOrgContext();
  const router = useRouter();
  const doc = useDocument(orgId, documentId);
  const versions = useVersions(orgId, documentId);
  const { update, restore, remove } = useDocumentMutations(orgId);
  const canWrite = can('document:write');

  const [title, setTitle] = useState('');
  const [html, setHtml] = useState('');
  const [baseVersion, setBaseVersion] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const [stale, setStale] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const previewDoc = useVersion(orgId, documentId, preview);

  const dirty = !!doc.data && (title !== doc.data.title || html !== doc.data.contentHtml) && baseVersion > 0;

  // Load the document; follow newer versions only when there are no unsaved local edits.
  useEffect(() => {
    if (!doc.data) return;
    if (baseVersion === 0 || (doc.data.version !== baseVersion && !dirty)) {
      setTitle(doc.data.title);
      setHtml(doc.data.contentHtml);
      setBaseVersion(doc.data.version);
      setResetKey((k) => k + 1);
      setStale(false);
    } else if (doc.data.version > baseVersion && dirty) {
      setStale(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.data]);

  const save = () => {
    if (!doc.data || !canWrite || !dirty) return;
    update.mutate(
      { id: documentId, title: title.trim() || doc.data.title, contentHtml: html, expectedVersion: baseVersion },
      {
        onSuccess: (d) => {
          setBaseVersion(d.version);
          setTitle(d.title);
          setStale(false);
        },
        onError: (e) => {
          if (e instanceof ApiError && e.status === 409) setStale(true);
        },
      },
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const reloadLatest = async () => {
    const r = await doc.refetch();
    if (r.data) {
      setTitle(r.data.title);
      setHtml(r.data.contentHtml);
      setBaseVersion(r.data.version);
      setResetKey((k) => k + 1);
      setStale(false);
    }
  };

  if (doc.isError) {
    const gone = doc.error instanceof ApiError && doc.error.status === 404;
    return <ErrorState title={gone ? 'Document not found' : 'Something went wrong'} message={gone ? 'It may have been deleted, or you don’t have access.' : undefined} onRetry={gone ? undefined : () => doc.refetch()} />;
  }

  return (
    <>
      <Link href={`/o/${orgId}/documents`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All documents
      </Link>
      <PageHeader
        title={doc.data?.title ?? 'Document'}
        description={doc.data ? `Version ${doc.data.version} · updated ${formatDate(doc.data.updatedAt, true)}` : undefined}
        actions={
          <>
            <Button variant="outline" onClick={() => setShowHistory((s) => !s)} aria-pressed={showHistory}><History className="h-4 w-4" aria-hidden /> History</Button>
            {canWrite ? (
              <>
                <Button variant="ghost" size="icon" aria-label="Delete document" onClick={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                <Button onClick={save} disabled={!dirty} loading={update.isPending}><Save className="h-4 w-4" aria-hidden /> {dirty ? 'Save' : 'Saved'}</Button>
              </>
            ) : <Badge>Read only</Badge>}
          </>
        }
      />

      {stale ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span className="flex-1">Someone else saved a newer version. Saving now would overwrite their changes.</span>
          <Button size="sm" variant="outline" onClick={reloadLatest}>Discard mine &amp; load latest</Button>
        </div>
      ) : null}

      <div className={cn('grid gap-6', showHistory && 'lg:grid-cols-[1fr_20rem]')}>
        <div className="min-w-0 space-y-4">
          {doc.isPending ? <Skeleton className="h-96 w-full" /> : (
            <>
              <Input aria-label="Document title" value={title} disabled={!canWrite} maxLength={200} onChange={(e) => setTitle(e.target.value)} className="h-12 text-lg font-semibold" />
              <RichEditor label="Document body" value={html} onChange={setHtml} editable={canWrite} resetKey={resetKey} />
            </>
          )}
        </div>

        {showHistory ? (
          <Card className="h-fit">
            <CardHeader title="Version history" description="Every save is kept." />
            <CardContent className="space-y-2">
              {versions.isPending ? <Skeleton className="h-24 w-full" /> : (
                <ul className="space-y-1">
                  {versions.data?.map((v) => (
                    <li key={v.version}>
                      <button
                        onClick={() => setPreview(v.version)}
                        className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-muted', preview === v.version && 'bg-primary-soft')}
                      >
                        <span className="font-medium">v{v.version}{v.version === doc.data?.version ? ' (current)' : ''}</span>
                        <time dateTime={v.createdAt} className="text-xs text-muted-foreground">{formatDate(v.createdAt, true)}</time>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {preview !== null ? (
        <Card className="mt-6">
          <CardHeader
            title={`Version ${preview}${previewDoc.data ? ` — ${previewDoc.data.title}` : ''}`}
            description="Read-only preview"
          />
          <CardContent className="space-y-3">
            {previewDoc.isPending ? <Skeleton className="h-32 w-full" /> : <RichEditor label={`Version ${preview} preview`} value={previewDoc.data?.contentHtml ?? ''} editable={false} resetKey={preview} />}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPreview(null)}>Close preview</Button>
              {canWrite && preview !== doc.data?.version ? (
                <Button
                  loading={restore.isPending}
                  disabled={dirty}
                  title={dirty ? 'Save or discard your edits first' : undefined}
                  onClick={() => restore.mutate({ id: documentId, version: preview, expectedVersion: baseVersion }, { onSuccess: (d) => { setPreview(null); setBaseVersion(d.version); setTitle(d.title); setHtml(d.contentHtml); setResetKey((k) => k + 1); } })}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden /> Restore this version
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${doc.data?.title ?? 'document'}”?`}
        description="The document is removed from search and AI answers. This action is recorded in the audit log."
        confirmLabel="Delete document"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate(documentId, { onSuccess: () => router.replace(`/o/${orgId}/documents`) })}
      />
    </>
  );
}
