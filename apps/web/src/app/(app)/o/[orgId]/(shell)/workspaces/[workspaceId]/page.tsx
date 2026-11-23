'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Trash2, UserPlus } from 'lucide-react';
import { updateWorkspaceSchema, type UpdateWorkspaceInput } from '@teamos/validation';
import { ROLES, ROLE_RANK } from '@teamos/permissions';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@teamos/ui';
import { PageHeader } from '@/components/page';
import {
  useMembers,
  useOrgMutations,
  useWorkspace,
  useWorkspaceMembers,
} from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { ApiError } from '@/lib/api';
import { ROLE_LABEL, ROLE_TONE } from '@/lib/labels';

/** Page 29 — Workspace Settings (details, members, deletion). */
export default function WorkspaceSettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { orgId, can, role } = useOrgContext();
  const router = useRouter();
  const ws = useWorkspace(orgId, workspaceId);
  const wsMembers = useWorkspaceMembers(orgId, workspaceId);
  const orgMembers = useMembers(orgId, can('member:read') && can('workspace:update'));
  const { updateWorkspace, deleteWorkspace, addWorkspaceMember, removeWorkspaceMember } = useOrgMutations(orgId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newUser, setNewUser] = useState('');
  const [newRole, setNewRole] = useState<(typeof ROLES)[number]>('DEVELOPER');
  const canEdit = can('workspace:update');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<UpdateWorkspaceInput>({ resolver: zodResolver(updateWorkspaceSchema) });
  useEffect(() => {
    if (ws.data) reset({ name: ws.data.name, description: ws.data.description ?? '' });
  }, [ws.data, reset]);

  if (ws.isError) {
    const gone = ws.error instanceof ApiError && ws.error.status === 404;
    return (
      <ErrorState
        title={gone ? 'Workspace not found' : 'Something went wrong'}
        message={gone ? 'It may have been deleted, or you don’t have access.' : undefined}
        onRetry={gone ? undefined : () => ws.refetch()}
      />
    );
  }

  const memberIds = new Set((wsMembers.data ?? []).map((m) => m.userId));
  const candidates = (orgMembers.data ?? []).filter((m) => !memberIds.has(m.userId));
  const assignable = ROLES.filter((r) => ROLE_RANK[r] <= ROLE_RANK[role] && (r !== 'OWNER' || role === 'OWNER'));

  return (
    <>
      <Link href={`/o/${orgId}/workspaces`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All workspaces
      </Link>
      <PageHeader title={ws.data?.name ?? 'Workspace'} description="Workspace settings and members." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <CardContent>
            {ws.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <form
                onSubmit={handleSubmit((v) =>
                  updateWorkspace.mutate({ id: workspaceId, name: v.name, description: v.description || null }),
                )}
                className="space-y-4"
                noValidate
              >
                <Field label="Name" htmlFor="name" error={errors.name?.message}>
                  <Input id="name" disabled={!canEdit} {...register('name')} />
                </Field>
                <Field label="Description" htmlFor="description" error={errors.description?.message}>
                  <Textarea id="description" rows={3} disabled={!canEdit} {...register('description')} />
                </Field>
                <Field label="URL name" htmlFor="slug" hint="The URL name can’t be changed.">
                  <Input id="slug" value={ws.data.slug} disabled readOnly />
                </Field>
                {canEdit ? (
                  <Button type="submit" disabled={!isDirty} loading={updateWorkspace.isPending}>
                    Save changes
                  </Button>
                ) : null}
              </form>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader title={`Members${wsMembers.data ? ` (${wsMembers.data.length})` : ''}`} />
          <CardContent>
            {wsMembers.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <ul className="divide-y divide-border">
                {wsMembers.data?.map((m) => (
                  <li key={m.userId} className="flex items-center gap-3 py-2.5">
                    <Avatar name={m.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{m.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    <Badge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</Badge>
                    {canEdit && ROLE_RANK[m.role] < ROLE_RANK[role] ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${m.name} from workspace`}
                        onClick={() => removeWorkspaceMember.mutate({ wsId: workspaceId, userId: m.userId })}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {canEdit ? (
              <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row">
                <Select aria-label="Add member" value={newUser} onChange={(e) => setNewUser(e.target.value)} className="sm:flex-1">
                  <option value="">Add an organization member…</option>
                  {candidates.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name} ({m.email})
                    </option>
                  ))}
                </Select>
                <Select aria-label="Workspace role" value={newRole} onChange={(e) => setNewRole(e.target.value as typeof newRole)} className="sm:w-40">
                  {assignable.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
                <Button
                  disabled={!newUser}
                  loading={addWorkspaceMember.isPending}
                  onClick={() =>
                    addWorkspaceMember.mutate(
                      { wsId: workspaceId, userId: newUser, role: newRole },
                      { onSuccess: () => setNewUser('') },
                    )
                  }
                >
                  <UserPlus className="h-4 w-4" aria-hidden /> Add
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {can('workspace:delete') ? (
        <Card className="mt-6 border-destructive/30">
          <CardHeader title="Danger zone" description="Deleting a workspace hides it for everyone in the organization." />
          <CardContent>
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              Delete workspace
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${ws.data?.name ?? 'workspace'}”?`}
        description="The workspace will no longer be accessible. This action is recorded in the audit log."
        confirmLabel="Delete workspace"
        destructive
        loading={deleteWorkspace.isPending}
        onConfirm={() =>
          deleteWorkspace.mutate(workspaceId, { onSuccess: () => router.replace(`/o/${orgId}/workspaces`) })
        }
      />
    </>
  );
}
