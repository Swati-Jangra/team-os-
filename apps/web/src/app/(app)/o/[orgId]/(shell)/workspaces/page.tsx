'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Layers, Plus } from 'lucide-react';
import { createWorkspaceSchema, type CreateWorkspaceInput } from '@teamos/validation';
import {
  Avatar,
  Button,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Textarea,
} from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useOrgMutations, useWorkspaces } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { formatDate } from '@/lib/labels';

function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrgContext();
  const { createWorkspace } = useOrgMutations(orgId);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateWorkspaceInput>({ resolver: zodResolver(createWorkspaceSchema) });

  const onSubmit = handleSubmit(async (values) => {
    await createWorkspace.mutateAsync({ name: values.name, description: values.description || undefined });
    reset();
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Create workspace" description="Workspaces group projects and people.">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Name" htmlFor="ws-name" error={errors.name?.message}>
            <Input id="ws-name" autoFocus aria-invalid={!!errors.name} {...register('name')} />
          </Field>
          <Field label="Description (optional)" htmlFor="ws-desc" error={errors.description?.message}>
            <Textarea id="ws-desc" rows={3} {...register('description')} />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={createWorkspace.isPending}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function WorkspacesPage() {
  const { orgId, can } = useOrgContext();
  const workspaces = useWorkspaces(orgId);
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Workspaces you can access in this organization."
        actions={
          can('workspace:create') ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New workspace
            </Button>
          ) : undefined
        }
      />
      {workspaces.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : workspaces.isError ? (
        <ErrorState message="Couldn't load workspaces." onRetry={() => workspaces.refetch()} />
      ) : workspaces.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Layers className="h-5 w-5" />}
            title="No workspaces yet"
            description={can('workspace:create') ? 'Create your first workspace to get started.' : 'Ask an admin to add you to a workspace.'}
            action={can('workspace:create') ? <Button onClick={() => setOpen(true)}>Create workspace</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.data.map((w) => (
            <Link
              key={w.id}
              href={`/o/${orgId}/workspaces/${w.id}`}
              className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Card className="h-full p-5 transition-shadow hover:shadow-pop">
                <div className="flex items-center gap-3">
                  <Avatar name={w.name} size="lg" />
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">{w.name}</h2>
                    <p className="text-xs text-muted-foreground">Created {formatDate(w.createdAt)}</p>
                  </div>
                </div>
                <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{w.description || 'No description'}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <CreateWorkspaceDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
