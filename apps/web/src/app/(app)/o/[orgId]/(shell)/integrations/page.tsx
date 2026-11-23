'use client';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Github, GitPullRequest, RefreshCw, Unplug } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Dialog, DialogContent, EmptyState, ErrorState, Field, Select, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { GoogleCards } from '@/features/google/google-cards';
import { useProjects } from '@/features/projects/api';
import { useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { useAvailableRepos, useExternalItems, useIntegrationMutations, useIntegrations, type IntegrationDto, type RepoDto } from '@/features/integrations/api';
import { KIND_LABEL, STATE_TONE, STATUS_LABEL, itemRef, safeUrl } from '@/features/integrations/meta';
import { timeAgo } from '@/lib/labels';

function ConnectRepoDialog({ integration, open, onOpenChange }: { integration: IntegrationDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const available = useAvailableRepos(orgId, integration.id, open);
  const { connectRepo } = useIntegrationMutations(orgId);
  const [fullName, setFullName] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [projectId, setProjectId] = useState('');
  const allProjects = useProjects(orgId);
  const projects = { data: (allProjects.data ?? []).filter((p) => p.workspaceId === workspaceId) };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Connect a repository" description="Its pull requests, issues and commits are visible to members of the chosen workspace only.">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await connectRepo.mutateAsync({ integrationId: integration.id, fullName, workspaceId, projectId: projectId || undefined }).then(() => { onOpenChange(false); setFullName(''); }, () => undefined);
          }}
        >
          <Field label="Repository" htmlFor="repo-name">
            {available.isError ? <p role="alert" className="text-sm text-destructive">Couldn&apos;t load your repositories. Try reconnecting GitHub.</p> : (
              <Select id="repo-name" required value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={available.isPending}>
                <option value="">{available.isPending ? 'Loading…' : 'Choose a repository'}</option>
                {(available.data ?? []).map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.private ? ' (private)' : ''}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Workspace" htmlFor="repo-ws">
            <Select id="repo-ws" required value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setProjectId(''); }}>
              <option value="">Choose a workspace</option>
              {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label="Project (optional)" htmlFor="repo-proj" hint="If set, task keys in commits and PRs only match tasks of this project.">
            <Select id="repo-proj" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!workspaceId}>
              <option value="">Any project in the workspace</option>
              {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={connectRepo.isPending} disabled={!fullName || !workspaceId}>Connect repository</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepoRow({ r }: { r: RepoDto }) {
  const { orgId } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const m = useIntegrationMutations(orgId);
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3 first:border-t-0" data-testid="repo-row">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{r.fullName}</p>
        <p className="text-xs text-muted-foreground">
          {workspaces.data?.find((w) => w.id === r.workspaceId)?.name ?? 'Workspace'} · {r.lastSyncedAt ? `synced ${timeAgo(r.lastSyncedAt)}` : 'not synced yet'}
          {r.webhookActive ? ' · live updates on' : ''}
        </p>
        {r.lastError ? <p role="alert" className="text-xs text-destructive">{r.lastError}</p> : null}
      </div>
      <Button size="sm" variant="outline" loading={m.syncRepo.isPending && m.syncRepo.variables === r.id} onClick={() => m.syncRepo.mutate(r.id)}><RefreshCw className="h-4 w-4" aria-hidden /> Sync now</Button>
      <Button size="sm" variant="ghost" aria-label={`Disconnect ${r.fullName}`} onClick={() => setConfirm(true)}><Unplug className="h-4 w-4" aria-hidden /></Button>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Disconnect ${r.fullName}?`} description="Syncing stops and the webhook is removed from GitHub. Items already synced stay visible." confirmLabel="Disconnect" destructive loading={m.disconnectRepo.isPending}
        onConfirm={() => m.disconnectRepo.mutate(r.id, { onSuccess: () => setConfirm(false) })} />
    </li>
  );
}

function ItemsCard() {
  const { orgId } = useOrgContext();
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const items = useExternalItems(orgId, kind, page, true);
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <h2 className="flex-1 font-semibold">Synced from GitHub</h2>
        <Select aria-label="Filter by type" className="w-44" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}>
          <option value="">All types</option><option value="PULL_REQUEST">Pull requests</option><option value="ISSUE">Issues</option><option value="COMMIT">Commits</option>
        </Select>
      </div>
      {items.isPending ? <Skeleton className="h-24 w-full" /> : items.isError ? <ErrorState message="Couldn't load synced items." onRetry={() => items.refetch()} /> :
        items.data.items.length === 0 ? <EmptyState icon={<GitPullRequest className="h-5 w-5" />} title="Nothing synced yet" description="Pull requests, issues and commits appear here after a repository is connected." /> : (
          <ul>
            {items.data.items.map((i) => {
              const href = safeUrl(i.url);
              return (
                <li key={i.id} className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3" data-testid="external-item">
                  <Badge tone="neutral">{KIND_LABEL[i.kind]}</Badge>
                  <span className="text-xs text-muted-foreground">{itemRef(i)}</span>
                  {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-sm hover:underline">{i.title}</a> : <span className="min-w-0 flex-1 truncate text-sm">{i.title}</span>}
                  {i.state ? <Badge tone={STATE_TONE[i.state] ?? 'neutral'}>{i.state}</Badge> : null}
                  {i.tasks.map((t) => <Badge key={t.id} tone="primary">{t.identifier}</Badge>)}
                </li>
              );
            })}
          </ul>
        )}
      {items.data && items.data.meta.totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <span className="text-sm text-muted-foreground">Page {items.data.meta.page} of {items.data.meta.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= items.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

const ERRORS: Record<string, string> = {
  google_denied: 'Google access was not granted, so nothing was connected.',
  google_scope_missing: 'The required permission was unchecked on Google\'s consent screen, so nothing was connected. Try again and keep it ticked.',
  google_no_refresh_token: 'Google did not grant lasting access. Remove TeamOS from your Google account\'s third-party access and connect again.',
  github_denied: 'GitHub access was not granted, so nothing was connected.',
};

export default function IntegrationsPage() {
  const { orgId, can } = useOrgContext();
  const q = useIntegrations(orgId);
  const m = useIntegrationMutations(orgId);
  const params = useSearchParams();
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const manage = can('integration:manage');
  const i = q.data?.integration ?? null;
  const st = i ? STATUS_LABEL[i.status] : null;
  return (
    <>
      <PageHeader title="Integrations" description="Connect GitHub, Google Calendar and Gmail. Everything synced is visible only to the workspace you choose, and nothing becomes work without a person's approval." />
      {params.get('connected') ? <p role="status" className="mb-4 rounded-lg bg-primary-soft p-3 text-sm text-primary">{params.get('connected') === 'google' ? 'Google connected.' : 'GitHub connected.'}</p> : null}
      {params.get('error') ? <p role="alert" className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{ERRORS[params.get('error')!] ?? 'Access was not granted, so nothing was connected.'}</p> : null}
      {q.isPending ? <Skeleton className="h-40 w-full" /> : q.isError ? <ErrorState message="Couldn't load integrations." onRetry={() => q.refetch()} /> : (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <Github className="h-8 w-8" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">GitHub</p>
                <p className="text-sm text-muted-foreground">{i ? `Signed in as ${i.accountLogin}` : 'Repositories, pull requests, issues and commits.'}</p>
              </div>
              {st ? <Badge tone={st.tone}>{st.label}</Badge> : null}
              {!q.data.configured ? <Badge tone="warning">Not configured on this server</Badge> : null}
              {manage && q.data.configured && (!i || i.status === 'ERROR') ? <Button loading={m.startGitHub.isPending} onClick={() => m.startGitHub.mutate()}>{i ? 'Reconnect GitHub' : 'Connect GitHub'}</Button> : null}
              {manage && i ? <Button variant="outline" onClick={() => setConfirm(true)}>Disconnect</Button> : null}
            </div>
            {i?.lastError ? <p role="alert" className="border-t border-border px-5 py-3 text-sm text-destructive">{i.lastError}</p> : null}
            {!q.data.configured ? <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">An administrator must set INTEGRATION_ENCRYPTION_KEY and the GitHub OAuth credentials on the server first.</p> : null}
            {!manage ? <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">Only owners and admins can connect or disconnect integrations.</p> : null}
          </Card>

          {i && i.status !== 'DISCONNECTED' ? (
            <Card className="mt-6">
              <div className="flex items-center gap-3 px-5 py-4">
                <h2 className="flex-1 font-semibold">Repositories</h2>
                {manage && i.status === 'CONNECTED' ? <Button size="sm" onClick={() => setDialog(true)}>Connect repository</Button> : null}
              </div>
              {q.data.repos.length === 0 ? <EmptyState icon={<Github className="h-5 w-5" />} title="No repositories connected" description="Choose a repository and the workspace whose members may see it." /> : <ul>{q.data.repos.map((r) => <RepoRow key={r.id} r={r} />)}</ul>}
              <ConnectRepoDialog integration={i} open={dialog} onOpenChange={setDialog} />
            </Card>
          ) : null}
          {i ? <ItemsCard /> : null}
          <GoogleCards />
          {i ? (
            <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Disconnect GitHub?" description="Syncing stops immediately, webhooks are removed and the stored token is deleted. Items already synced stay visible." confirmLabel="Disconnect" destructive loading={m.disconnect.isPending}
              onConfirm={() => m.disconnect.mutate(i.id, { onSuccess: () => setConfirm(false) })} />
          ) : null}
        </>
      )}
    </>
  );
}
