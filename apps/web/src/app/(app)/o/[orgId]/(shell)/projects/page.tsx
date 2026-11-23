'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FolderKanban, Plus } from 'lucide-react';
import { createProjectSchema, type CreateProjectInput } from '@teamos/validation';
import { Badge, Button, Card, Dialog, DialogContent, EmptyState, ErrorState, Field, Input, Select, Skeleton, Textarea } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { useProjectMutations, useProjects } from '@/features/projects/api';
import { PROJECT_STATUS, formatDay, type ProjectStatus } from '@/features/projects/meta';
import { ProgressBar } from '@/features/projects/views';

const blankToUndef = (v: unknown) => (v === '' ? undefined : v);

function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const { createProject } = useProjectMutations(orgId);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<CreateProjectInput>({ resolver: zodResolver(createProjectSchema) });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Create project" description="Projects hold tasks, milestones and a timeline.">
        <form
          noValidate
          className="space-y-4"
          onSubmit={handleSubmit(async (v) => {
            await createProject.mutateAsync(v);
            reset();
            onOpenChange(false);
          })}
        >
          <Field label="Workspace" htmlFor="p-ws" error={errors.workspaceId?.message}>
            <Select id="p-ws" defaultValue="" {...register('workspaceId')}>
              <option value="" disabled>Select a workspace…</option>
              {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label="Project name" htmlFor="p-name" error={errors.name?.message}>
            <Input id="p-name" autoFocus {...register('name')} />
          </Field>
          <Field label="Key (optional)" htmlFor="p-key" error={errors.key?.message} hint="Short prefix for task IDs, e.g. WEB → WEB-12. Generated if empty.">
            <Input id="p-key" className="uppercase" maxLength={10} {...register('key', { setValueAs: blankToUndef })} />
          </Field>
          <Field label="Description (optional)" htmlFor="p-desc" error={errors.description?.message}>
            <Textarea id="p-desc" rows={3} {...register('description', { setValueAs: blankToUndef })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" htmlFor="p-start" error={errors.startDate?.message}>
              <Input id="p-start" type="date" {...register('startDate', { setValueAs: (v) => (v === '' ? null : v) })} />
            </Field>
            <Field label="Due" htmlFor="p-due" error={errors.dueDate?.message}>
              <Input id="p-due" type="date" {...register('dueDate', { setValueAs: (v) => (v === '' ? null : v) })} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={createProject.isPending}>Create project</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ProjectsPage() {
  const { orgId, can } = useOrgContext();
  const projects = useProjects(orgId);
  const workspaces = useWorkspaces(orgId);
  const [open, setOpen] = useState(false);
  const [ws, setWs] = useState('');
  const [status, setStatus] = useState<ProjectStatus | ''>('');
  const wsName = (id: string) => workspaces.data?.find((w) => w.id === id)?.name ?? '';
  const shown = (projects.data ?? []).filter((p) => (!ws || p.workspaceId === ws) && (!status || p.status === status));
  const canCreate = can('project:create');

  return (
    <>
      <PageHeader
        title="Projects"
        description="Plan and track work across your workspaces."
        actions={canCreate ? <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden /> New project</Button> : undefined}
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select aria-label="Filter by workspace" className="w-full sm:w-56" value={ws} onChange={(e) => setWs(e.target.value)}>
          <option value="">All workspaces</option>
          {(workspaces.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
        <Select aria-label="Filter by status" className="w-full sm:w-44" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus | '')}>
          <option value="">All statuses</option>
          {(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => <option key={s} value={s}>{PROJECT_STATUS[s].label}</option>)}
        </Select>
      </div>

      {projects.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full" />)}</div>
      ) : projects.isError ? (
        <ErrorState message="Couldn't load projects." onRetry={() => projects.refetch()} />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderKanban className="h-5 w-5" />}
            title={projects.data.length === 0 ? 'No projects yet' : 'No projects match these filters'}
            description={projects.data.length === 0 ? (canCreate ? 'Create your first project to start planning tasks.' : 'Projects you can access will show up here.') : undefined}
            action={projects.data.length === 0 && canCreate ? <Button onClick={() => setOpen(true)}>Create project</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p) => (
            <Link key={p.id} href={`/o/${orgId}/projects/${p.id}`} className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="h-full p-5 transition-shadow hover:shadow-pop">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold">{p.name}</h2>
                    <p className="text-xs text-muted-foreground">{wsName(p.workspaceId)}</p>
                  </div>
                  <Badge>{p.key}</Badge>
                </div>
                <p className="mt-2 line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">{p.description || 'No description'}</p>
                <div className="mt-3"><ProgressBar done={p.doneCount} total={p.taskCount} /></div>
                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <Badge tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</Badge>
                  <span>{p.taskCount} tasks{p.dueDate ? ` · due ${formatDay(p.dueDate)}` : ''}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      {canCreate ? <CreateProjectDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
