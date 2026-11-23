'use client';
import { useState } from 'react';
import { Mail, MailPlus, Trash2, Users } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createInvitationSchema, type CreateInvitationInput } from '@teamos/validation';
import { ROLES, canAssignRole, canInviteWithRole, canRemoveMember, type RoleName } from '@teamos/permissions';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
} from '@teamos/ui';
import { PageHeader } from '@/components/page';
import {
  useInvitations,
  useMembers,
  useOrgMutations,
  useWorkspaces,
  type MemberDto,
} from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { formatDate, ROLE_LABEL, ROLE_TONE } from '@/lib/labels';

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId, role } = useOrgContext();
  const { invite } = useOrgMutations(orgId);
  const workspaces = useWorkspaces(orgId);
  const allowed = ROLES.filter((r) => r !== 'OWNER' && canInviteWithRole(role, r));
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateInvitationInput>({
    resolver: zodResolver(createInvitationSchema),
    defaultValues: { role: allowed.includes('DEVELOPER') ? 'DEVELOPER' : allowed[0], workspaceIds: [] },
  });
  const selected = watch('workspaceIds') ?? [];

  const onSubmit = handleSubmit(async (values) => {
    await invite.mutateAsync({ email: values.email, role: values.role, workspaceIds: values.workspaceIds });
    reset();
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Invite a teammate" description="They’ll get an email with a link valid for 7 days.">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="Email" htmlFor="invite-email" error={errors.email?.message}>
            <Input id="invite-email" type="email" autoFocus aria-invalid={!!errors.email} {...register('email')} />
          </Field>
          <Field label="Role" htmlFor="invite-role" error={errors.role?.message}>
            <Select id="invite-role" {...register('role')}>
              {allowed.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          {(workspaces.data?.length ?? 0) > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Add to workspaces (optional)</legend>
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {workspaces.data!.map((w) => (
                  <label key={w.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[hsl(var(--primary))]"
                      checked={selected.includes(w.id)}
                      onChange={(e) =>
                        setValue(
                          'workspaceIds',
                          e.target.checked ? [...selected, w.id] : selected.filter((id) => id !== w.id),
                        )
                      }
                    />
                    {w.name}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={invite.isPending}>
              Send invitation
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({ m, onRemove }: { m: MemberDto; onRemove: (m: MemberDto) => void }) {
  const { orgId, role, userId } = useOrgContext();
  const { changeRole } = useOrgMutations(orgId);
  const isSelf = m.userId === userId;
  const options = ROLES.filter((r) => r === m.role || canAssignRole(role, m.role as RoleName, r));
  const canChange = !isSelf && options.length > 1;
  const canRemove = !isSelf && canRemoveMember(role, m.role as RoleName);

  return (
    <tr className="border-t border-border">
      <td className="py-3 pl-5 pr-3">
        <div className="flex items-center gap-3">
          <Avatar name={m.name} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {m.name} {isSelf ? <span className="text-xs font-normal text-muted-foreground">(you)</span> : null}
            </p>
            <p className="truncate text-xs text-muted-foreground">{m.email}</p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        {canChange ? (
          <Select
            aria-label={`Role for ${m.name}`}
            className="h-9 w-44"
            value={m.role}
            disabled={changeRole.isPending}
            onChange={(e) => changeRole.mutate({ userId: m.userId, role: e.target.value as RoleName })}
          >
            {options.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        ) : (
          <Badge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</Badge>
        )}
      </td>
      <td className="hidden px-3 py-3 text-sm text-muted-foreground sm:table-cell">{formatDate(m.createdAt)}</td>
      <td className="py-3 pl-3 pr-5 text-right">
        {canRemove ? (
          <Button variant="ghost" size="icon" aria-label={`Remove ${m.name}`} onClick={() => onRemove(m)}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

export default function MembersPage() {
  const { orgId, can } = useOrgContext();
  const members = useMembers(orgId);
  const invitations = useInvitations(orgId, can('member:invite'));
  const { removeMember, revokeInvitation } = useOrgMutations(orgId);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [toRemove, setToRemove] = useState<MemberDto | null>(null);

  const pending = (invitations.data ?? []).filter((i) => !i.acceptedAt && !i.revokedAt);

  return (
    <>
      <PageHeader
        title="Team members"
        description="Everyone in your organization and what they can do."
        actions={
          can('member:invite') ? (
            <Button onClick={() => setInviteOpen(true)}>
              <MailPlus className="h-4 w-4" aria-hidden /> Invite teammate
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardHeader title={`Members${members.data ? ` (${members.data.length})` : ''}`} />
        <CardContent className="overflow-x-auto p-0 pb-2">
          {members.isPending ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : members.isError ? (
            <ErrorState message="Couldn't load members." onRetry={() => members.refetch()} />
          ) : members.data.length === 0 ? (
            <EmptyState icon={<Users className="h-5 w-5" />} title="No members" />
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pl-5 pr-3 font-medium">Member</th>
                  <th className="px-3 pb-2 font-medium">Role</th>
                  <th className="hidden px-3 pb-2 font-medium sm:table-cell">Joined</th>
                  <th className="pb-2 pl-3 pr-5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.data.map((m) => (
                  <MemberRow key={m.userId} m={m} onRemove={setToRemove} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {can('member:invite') ? (
        <Card className="mt-6">
          <CardHeader title="Pending invitations" description="Invitations that haven’t been accepted yet." />
          <CardContent>
            {invitations.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : pending.length === 0 ? (
              <EmptyState icon={<Mail className="h-5 w-5" />} title="No pending invitations" />
            ) : (
              <ul className="divide-y divide-border">
                {pending.map((i) => {
                  const expired = new Date(i.expiresAt).getTime() <= Date.now();
                  return (
                    <li key={i.id} className="flex items-center gap-3 py-3">
                      <Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{i.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {expired ? 'Expired' : `Expires ${formatDate(i.expiresAt)}`}
                        </p>
                      </div>
                      <Badge tone={ROLE_TONE[i.role]}>{ROLE_LABEL[i.role]}</Badge>
                      {expired ? <Badge tone="warning">Expired</Badge> : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => revokeInvitation.mutate(i.id)}
                        loading={revokeInvitation.isPending && revokeInvitation.variables === i.id}
                      >
                        Revoke
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <ConfirmDialog
        open={!!toRemove}
        onOpenChange={(o) => !o && setToRemove(null)}
        title={`Remove ${toRemove?.name ?? 'member'}?`}
        description="They’ll immediately lose access to this organization and all its workspaces. You can invite them again later."
        confirmLabel="Remove member"
        destructive
        loading={removeMember.isPending}
        onConfirm={() =>
          toRemove && removeMember.mutate(toRemove.userId, { onSettled: () => setToRemove(null) })
        }
      />
    </>
  );
}
