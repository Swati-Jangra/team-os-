'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Search, Settings2, Sparkles } from 'lucide-react';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, ErrorState, Field, Input, Select, Skeleton, Textarea, cn } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useWorkspaceMembers } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { useMilestones, useProject, useProjectMutations, useTasks, type ProjectDto } from '@/features/projects/api';
import { PROJECT_STATUS, formatDay, type ProjectStatus } from '@/features/projects/meta';
import { TaskDrawer } from '@/features/projects/task-drawer';
import { ActivityPanel, Board, ListView, MilestonesPanel, ProgressBar, Timeline } from '@/features/projects/views';
import { ApiError } from '@/lib/api';
import { PlanDialog } from '@/features/meetings/plan-dialog';

const VIEWS = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'activity', label: 'Activity' },
] as const;
type View = (typeof VIEWS)[number]['id'];

function SettingsDialog({ project, open, onOpenChange }: { project: ProjectDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId, can } = useOrgContext();
  const router = useRouter();
  const { updateProject, deleteProject } = useProjectMutations(orgId);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [start, setStart] = useState(project.startDate ?? '');
  const [due, setDue] = useState(project.dueDate ?? '');
  const [confirm, setConfirm] = useState(false);
  const bad = !!start && !!due && due < start;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Project settings" description={`${project.key} · created ${formatDay(project.createdAt.slice(0, 10))}`}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || bad) return;
            updateProject.mutate(
              { id: project.id, body: { name: name.trim(), description: description.trim() || null, status, startDate: start || null, dueDate: due || null } },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          <Field label="Name" htmlFor="s-name"><Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Description" htmlFor="s-desc"><Textarea id="s-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Field label="Status" htmlFor="s-status">
            <Select id="s-status" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => <option key={s} value={s}>{PROJECT_STATUS[s].label}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" htmlFor="s-start"><Input id="s-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Due" htmlFor="s-due" error={bad ? 'Due date must be on or after the start date' : undefined}><Input id="s-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
          <div className="flex items-center justify-between pt-2">
            {can('project:delete') ? <Button variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>Delete project</Button> : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || bad} loading={updateProject.isPending}>Save</Button>
            </div>
          </div>
        </form>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Delete ${project.name}?`}
          description="The project and all of its tasks will be hidden for everyone. This is recorded in the audit log."
          confirmLabel="Delete project"
          destructive
          loading={deleteProject.isPending}
          onConfirm={() => deleteProject.mutate(project.id, { onSuccess: () => router.replace(`/o/${orgId}/projects`) })}
        />
      </DialogContent>
    </Dialog>
  );
}

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { orgId, can } = useOrgContext();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const project = useProject(orgId, projectId);
  const tasks = useTasks(orgId, projectId);
  const milestones = useMilestones(orgId, projectId);
  const members = useWorkspaceMembers(orgId, project.data?.workspaceId ?? '');
  const [q, setQ] = useState('');
  const [assignee, setAssignee] = useState('');
  const [milestone, setMilestone] = useState('');
  const [settings, setSettings] = useState(false);
  const [plan, setPlan] = useState(false);

  const view = (VIEWS.find((v) => v.id === sp.get('view'))?.id ?? 'board') as View;
  const openTask = sp.get('task');
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp.toString());
    if (v) next.set(k, v); else next.delete(k);
    router.replace(`${pathname}?${next}`, { scroll: false });
  };
  useEffect(() => { document.title = project.data ? `${project.data.name} · TeamOS AI` : 'Project · TeamOS AI'; }, [project.data]);

  if (project.isError) {
    const gone = project.error instanceof ApiError && project.error.status === 404;
    return <ErrorState title={gone ? 'Project not found' : 'Something went wrong'} message={gone ? 'It may have been deleted, or you don’t have access.' : undefined} onRetry={gone ? undefined : () => project.refetch()} />;
  }
  const p = project.data;
  const filtered = (tasks.data ?? []).filter((t) =>
    (!q || t.title.toLowerCase().includes(q.toLowerCase()) || t.identifier.toLowerCase().includes(q.toLowerCase())) &&
    (!assignee || (assignee === 'none' ? !t.assigneeId : t.assigneeId === assignee)) &&
    (!milestone || t.milestoneId === milestone),
  );
  const filtering = !!(q || assignee || milestone);

  return (
    <>
      <Link href={`/o/${orgId}/projects`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All projects
      </Link>
      <PageHeader
        title={p?.name ?? 'Project'}
        description={p ? `${p.key}${p.startDate || p.dueDate ? ` · ${formatDay(p.startDate)} → ${formatDay(p.dueDate)}` : ''}` : undefined}
        actions={p ? (
          <>
            <Badge tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</Badge>
            {can('ai:use') && can('task:create') ? <Button variant="outline" onClick={() => setPlan(true)}><Sparkles className="h-4 w-4" aria-hidden /> Plan with AI</Button> : null}
            {can('project:update') ? <Button variant="outline" onClick={() => setSettings(true)}><Settings2 className="h-4 w-4" aria-hidden /> Settings</Button> : null}
          </>
        ) : undefined}
      />
      {p ? <div className="mb-5 max-w-md"><ProgressBar done={p.doneCount} total={p.taskCount} /></div> : <Skeleton className="mb-5 h-3 w-64" />}

      <div role="tablist" aria-label="Project views" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            type="button"
            aria-selected={view === v.id}
            onClick={() => setParam('view', v.id === 'board' ? null : v.id)}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', view === v.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === 'board' || view === 'list' || view === 'timeline' ? (
        <div className="mb-4 flex flex-wrap gap-3">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input aria-label="Search tasks" className="pl-9" placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select aria-label="Filter by assignee" className="w-full sm:w-44" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">All assignees</option>
            <option value="none">Unassigned</option>
            {(members.data ?? []).map((u) => <option key={u.userId} value={u.userId}>{u.name}</option>)}
          </Select>
          <Select aria-label="Filter by milestone" className="w-full sm:w-44" value={milestone} onChange={(e) => setMilestone(e.target.value)}>
            <option value="">All milestones</option>
            {(milestones.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          {filtering ? <Button variant="ghost" onClick={() => { setQ(''); setAssignee(''); setMilestone(''); }}>Clear</Button> : null}
        </div>
      ) : null}

      {tasks.isPending && (view === 'board' || view === 'list' || view === 'timeline') ? (
        <Skeleton className="h-64 w-full" />
      ) : tasks.isError ? (
        <ErrorState message="Couldn't load tasks." onRetry={() => tasks.refetch()} />
      ) : view === 'board' ? (
        <Board projectId={projectId} tasks={filtered} onOpen={(id) => setParam('task', id)} />
      ) : view === 'list' ? (
        <ListView projectId={projectId} tasks={filtered} onOpen={(id) => setParam('task', id)} />
      ) : view === 'timeline' ? (
        <Timeline projectId={projectId} tasks={filtered} onOpen={(id) => setParam('task', id)} />
      ) : view === 'milestones' ? (
        <MilestonesPanel projectId={projectId} />
      ) : p ? (
        <ActivityPanel projectId={projectId} workspaceId={p.workspaceId} />
      ) : null}

      <TaskDrawer taskId={openTask} onClose={() => setParam('task', null)} />
      {p && plan ? <PlanDialog projectId={projectId} open={plan} onOpenChange={setPlan} /> : null}
      {p && settings ? <SettingsDialog project={p} open={settings} onOpenChange={setSettings} /> : null}
    </>
  );
}
