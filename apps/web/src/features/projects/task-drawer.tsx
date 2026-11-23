'use client';
import { useState } from 'react';
import { Link2, Lock, Trash2, X } from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@teamos/ui';
import { KIND_LABEL, STATE_TONE, itemRef, safeUrl } from '@/features/integrations/meta';
import { useLinkMutations, useTaskLinks } from '@/features/integrations/api';
import { useWorkspaceMembers } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { timeAgo } from '@/lib/labels';
import {
  useComments,
  useMilestones,
  useProjectMutations,
  useTask,
  useTaskActivity,
  useTasks,
  type TaskDetailDto,
} from './api';
import { ALL_TASK_STATUSES, PRIORITIES, PRIORITY, TASK_STATUS, activityText, isOverdue, type TaskPriority, type TaskStatus } from './meta';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-3">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function TaskForm({ task }: { task: TaskDetailDto }) {
  const { orgId, can, userId } = useOrgContext();
  const m = useProjectMutations(orgId);
  const members = useWorkspaceMembers(orgId, task.workspaceId);
  const milestones = useMilestones(orgId, task.projectId);
  const siblings = useTasks(orgId, task.projectId);
  const comments = useComments(orgId, task.id);
  const activity = useTaskActivity(orgId, task.id);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [labels, setLabels] = useState(task.labels.join(', '));
  const [comment, setComment] = useState('');
  const [depId, setDepId] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canEdit = can('task:update');
  const canAssign = can('task:assign');
  const save = (body: Parameters<typeof m.updateTask.mutate>[0]['body']) =>
    m.updateTask.mutate({ id: task.id, projectId: task.projectId, body });

  // Non-assigners may only assign to themselves.
  const assignable = (members.data ?? []).filter((u) => canAssign || u.userId === userId);
  const takenDeps = new Set([task.id, ...task.blockedBy.map((b) => b.id)]);
  const depCandidates = (siblings.data ?? []).filter((t) => !takenDeps.has(t.id));
  const overdue = isOverdue(task.dueDate, task.status);

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 font-mono text-xs text-muted-foreground">{task.identifier}</p>
        <Input
          aria-label="Task title"
          className="h-auto border-transparent px-0 text-xl font-semibold shadow-none hover:border-input focus:px-3"
          value={title}
          disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const t = title.trim();
            if (!t) setTitle(task.title);
            else if (t !== task.title) save({ title: t });
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {task.openBlockers > 0 ? (
          <p className="mt-1 flex items-center gap-1 text-xs text-warning">
            <Lock className="h-3 w-3" aria-hidden /> Blocked by {task.openBlockers} unfinished {task.openBlockers === 1 ? 'task' : 'tasks'}
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        <Row label="Status">
          <Select aria-label="Status" value={task.status} disabled={!canEdit} onChange={(e) => save({ status: e.target.value as TaskStatus })}>
            {ALL_TASK_STATUSES.map((s) => (
              <option key={s} value={s}>{TASK_STATUS[s].label}</option>
            ))}
          </Select>
        </Row>
        <Row label="Priority">
          <Select aria-label="Priority" value={task.priority} disabled={!canEdit} onChange={(e) => save({ priority: e.target.value as TaskPriority })}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{PRIORITY[p].label}</option>
            ))}
          </Select>
        </Row>
        <Row label="Assignee">
          <Select aria-label="Assignee" value={task.assigneeId ?? ''} disabled={!canEdit} onChange={(e) => save({ assigneeId: e.target.value || null })}>
            <option value="">Unassigned</option>
            {task.assigneeId && !assignable.some((u) => u.userId === task.assigneeId) ? (
              <option value={task.assigneeId}>{task.assigneeName ?? 'Current assignee'}</option>
            ) : null}
            {assignable.map((u) => (
              <option key={u.userId} value={u.userId}>{u.name}</option>
            ))}
          </Select>
        </Row>
        <Row label="Milestone">
          <Select aria-label="Milestone" value={task.milestoneId ?? ''} disabled={!canEdit} onChange={(e) => save({ milestoneId: e.target.value || null })}>
            <option value="">None</option>
            {(milestones.data ?? []).map((ms) => (
              <option key={ms.id} value={ms.id}>{ms.name}</option>
            ))}
          </Select>
        </Row>
        <Row label="Start">
          <Input type="date" aria-label="Start date" value={task.startDate ?? ''} disabled={!canEdit} onChange={(e) => save({ startDate: e.target.value || null })} />
        </Row>
        <Row label="Due">
          <div className="flex items-center gap-2">
            <Input type="date" aria-label="Due date" value={task.dueDate ?? ''} disabled={!canEdit} onChange={(e) => save({ dueDate: e.target.value || null })} />
            {overdue ? <Badge tone="danger">Overdue</Badge> : null}
          </div>
        </Row>
        <Row label="Estimate (h)">
          <Input
            type="number"
            min={0}
            step={0.5}
            aria-label="Estimate in hours"
            defaultValue={task.estimateHours ?? ''}
            disabled={!canEdit}
            onBlur={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value);
              if (v !== task.estimateHours && (v === null || v >= 0)) save({ estimateHours: v });
            }}
          />
        </Row>
        <Row label="Labels">
          <Input
            aria-label="Labels"
            placeholder="comma, separated"
            value={labels}
            disabled={!canEdit}
            onChange={(e) => setLabels(e.target.value)}
            onBlur={() => {
              const next = labels.split(',').map((l) => l.trim()).filter(Boolean).slice(0, 10);
              if (next.join('|') !== task.labels.join('|')) save({ labels: next });
            }}
          />
        </Row>
      </div>

      <section aria-labelledby="desc-h" className="space-y-2">
        <h3 id="desc-h" className="text-sm font-semibold">Description</h3>
        <Textarea rows={4} value={description} disabled={!canEdit} placeholder="Add more detail…" onChange={(e) => setDescription(e.target.value)} />
        {canEdit && description !== (task.description ?? '') ? (
          <div className="flex gap-2">
            <Button size="sm" loading={m.updateTask.isPending} onClick={() => save({ description: description.trim() || null })}>Save description</Button>
            <Button size="sm" variant="ghost" onClick={() => setDescription(task.description ?? '')}>Discard</Button>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="dep-h" className="space-y-2">
        <h3 id="dep-h" className="flex items-center gap-1.5 text-sm font-semibold"><Link2 className="h-4 w-4" aria-hidden /> Dependencies</h3>
        <p className="text-xs text-muted-foreground">This task can’t be marked done until everything it depends on is done.</p>
        {task.blockedBy.length === 0 ? <p className="text-sm text-muted-foreground">Not blocked by any task.</p> : (
          <ul className="space-y-1">
            {task.blockedBy.map((b) => (
              <li key={b.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{b.identifier}</span>
                <span className="min-w-0 flex-1 truncate">{b.title}</span>
                <Badge tone={TASK_STATUS[b.status].tone}>{TASK_STATUS[b.status].label}</Badge>
                {canEdit ? (
                  <Button variant="ghost" size="icon" aria-label={`Remove dependency on ${b.identifier}`} onClick={() => m.removeDependency.mutate({ id: task.id, projectId: task.projectId, dependsOnTaskId: b.id })}>
                    <X className="h-4 w-4" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {task.blocks.length > 0 ? (
          <p className="text-xs text-muted-foreground">Blocks: {task.blocks.map((b) => b.identifier).join(', ')}</p>
        ) : null}
        {canEdit ? (
          <div className="flex gap-2">
            <Select aria-label="Add dependency" value={depId} onChange={(e) => setDepId(e.target.value)}>
              <option value="">Depends on…</option>
              {depCandidates.map((t) => (
                <option key={t.id} value={t.id}>{t.identifier} — {t.title}</option>
              ))}
            </Select>
            <Button variant="outline" disabled={!depId} loading={m.addDependency.isPending} onClick={() => m.addDependency.mutate({ id: task.id, projectId: task.projectId, dependsOnTaskId: depId }, { onSuccess: () => setDepId('') })}>
              Add
            </Button>
          </div>
        ) : null}
      </section>

      <GitHubLinks taskId={task.id} canEdit={canEdit} />

      <section aria-labelledby="com-h" className="space-y-3">
        <h3 id="com-h" className="text-sm font-semibold">Comments {comments.data ? `(${comments.data.length})` : ''}</h3>
        {comments.isPending ? <Skeleton className="h-16 w-full" /> : (
          <ul className="space-y-3">
            {comments.data?.map((c) => (
              <li key={c.id} className="flex gap-3">
                <Avatar name={c.authorName} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{c.authorName}</span>{' '}
                    <span className="text-xs text-muted-foreground">{timeAgo(c.createdAt)}{c.editedAt ? ' · edited' : ''}</span>
                  </p>
                  {editing?.id === c.id ? (
                    <div className="mt-1 space-y-2">
                      <Textarea rows={3} value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} aria-label="Edit comment" />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={!editing.body.trim()} loading={m.editComment.isPending} onClick={() => m.editComment.mutate({ id: c.id, taskId: task.id, body: editing.body }, { onSuccess: () => setEditing(null) })}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{c.body}</p>
                  )}
                  {editing?.id !== c.id && (c.authorId === userId || can('task:delete')) ? (
                    <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
                      {c.authorId === userId ? <button type="button" className="hover:text-foreground" onClick={() => setEditing({ id: c.id, body: c.body })}>Edit</button> : null}
                      <button type="button" className="hover:text-destructive" onClick={() => m.deleteComment.mutate({ id: c.id, taskId: task.id, projectId: task.projectId })}>Delete</button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {can('comment:create') ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!comment.trim()) return;
              m.addComment.mutate({ taskId: task.id, projectId: task.projectId, body: comment.trim() }, { onSuccess: () => setComment('') });
            }}
          >
            <Textarea rows={2} aria-label="Write a comment" placeholder="Write a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
            <Button type="submit" size="sm" disabled={!comment.trim()} loading={m.addComment.isPending}>Comment</Button>
          </form>
        ) : null}
      </section>

      <section aria-labelledby="act-h" className="space-y-2">
        <h3 id="act-h" className="text-sm font-semibold">Activity</h3>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          {(activity.data ?? []).slice(0, 15).map((a) => {
            const who = (members.data ?? []).find((u) => u.userId === a.actorId)?.name ?? 'Someone';
            return (
              <li key={a.id}>
                <span className="font-medium text-foreground">{who}</span> {activityText(a.action, a.metadata)} · {timeAgo(a.createdAt)}
              </li>
            );
          })}
        </ul>
      </section>

      {can('task:delete') ? (
        <div className="border-t border-border pt-4">
          <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4" aria-hidden /> Delete task
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete ${task.identifier}?`}
            description="The task and its dependency links are removed. This is recorded in the audit log."
            confirmLabel="Delete task"
            destructive
            loading={m.deleteTask.isPending}
            onConfirm={() => m.deleteTask.mutate({ id: task.id, projectId: task.projectId }, { onSuccess: () => setConfirmDelete(false) })}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Right-hand drawer with everything about one task. `taskId = null` closes it. */
export function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { orgId } = useOrgContext();
  const task = useTask(orgId, taskId);
  return (
    <Dialog open={!!taskId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Task details"
        className="left-auto right-0 top-0 h-full max-w-xl translate-x-0 translate-y-0 overflow-y-auto rounded-none rounded-l-2xl"
      >
        {task.isPending ? (
          <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40 w-full" /></div>
        ) : task.isError ? (
          <ErrorState title="Task not found" message="It may have been deleted, or you don’t have access." />
        ) : (
          <TaskForm key={task.data.id} task={task.data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GitHubLinks({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const { orgId } = useOrgContext();
  const links = useTaskLinks(orgId, taskId);
  const { unlink } = useLinkMutations(orgId, taskId);
  if (links.isPending || links.isError || links.data.length === 0) return null; // nothing linked: stay out of the way
  return (
    <section aria-labelledby="gh-h" className="space-y-2" data-testid="task-github-links">
      <h3 id="gh-h" className="text-sm font-semibold">GitHub</h3>
      <ul className="space-y-1">
        {links.data.map((l) => {
          const href = safeUrl(l.url);
          return (
            <li key={l.linkId} className="flex items-center gap-2 text-sm">
              <Badge tone="neutral">{KIND_LABEL[l.kind]}</Badge>
              <span className="text-xs text-muted-foreground">{itemRef(l)}</span>
              {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate hover:underline">{l.title}</a> : <span className="min-w-0 flex-1 truncate">{l.title}</span>}
              {l.state ? <Badge tone={STATE_TONE[l.state] ?? 'neutral'}>{l.state}</Badge> : null}
              {canEdit ? <button type="button" aria-label={`Unlink ${l.title}`} className="text-muted-foreground hover:text-foreground" onClick={() => unlink.mutate(l.linkId)}><X className="h-3.5 w-3.5" aria-hidden /></button> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
