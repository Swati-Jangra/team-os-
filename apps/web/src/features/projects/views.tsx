'use client';
import { useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, Diamond, Flag, ListChecks, Lock, MessageSquare, Plus, Trash2 } from 'lucide-react';
import { Avatar, Badge, Button, Card, CardContent, CardHeader, EmptyState, Input, Select, Skeleton } from '@teamos/ui';
import { useWorkspaceMembers } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { cn } from '@teamos/ui';
import { timeAgo } from '@/lib/labels';
import { useMilestones, useProjectActivity, useProjectMutations, type MilestoneDto, type TaskDto } from './api';
import {
  ALL_TASK_STATUSES,
  BOARD_COLUMNS,
  PRIORITY,
  TASK_STATUS,
  activityText,
  formatDay,
  isOverdue,
  parseDay,
  percent,
  type TaskStatus,
} from './meta';

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const p = percent(done, total);
  return (
    <div className="flex items-center gap-2" title={`${done} of ${total} done`}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
        <div className="h-full rounded-full bg-primary" style={{ width: `${p}%` }} />
      </div>
      <span className="w-9 text-right text-xs text-muted-foreground">{p}%</span>
    </div>
  );
}

function DueLabel({ t }: { t: TaskDto }) {
  if (!t.dueDate) return null;
  const late = isOverdue(t.dueDate, t.status);
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', late ? 'font-medium text-destructive' : 'text-muted-foreground')}>
      <CalendarClock className="h-3 w-3" aria-hidden /> {formatDay(t.dueDate)}
    </span>
  );
}

// ---------------------------------------------------------------- Board

function Card_({ t, draggable, onOpen, onDragStart, onDropOn }: {
  t: TaskDto; draggable: boolean; onOpen: () => void; onDragStart: () => void; onDropOn: () => void;
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={(e) => draggable && e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropOn(); }}
      className="rounded-xl border border-border bg-card p-3 shadow-card transition-shadow hover:shadow-pop"
    >
      <button type="button" onClick={onOpen} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
        <p className="font-mono text-[11px] text-muted-foreground">{t.identifier}</p>
        <p className="mt-0.5 text-sm font-medium leading-snug">{t.title}</p>
      </button>
      {t.labels.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {t.labels.slice(0, 3).map((l) => <Badge key={l}>{l}</Badge>)}
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge>
        <DueLabel t={t} />
        <span className="ml-auto flex items-center gap-2 text-muted-foreground">
          {t.openBlockers > 0 ? <span title={`Blocked by ${t.openBlockers}`}><Lock className="h-3.5 w-3.5 text-warning" aria-label="Blocked" /></span> : null}
          {t.commentCount > 0 ? <span className="flex items-center gap-0.5 text-xs"><MessageSquare className="h-3.5 w-3.5" aria-hidden />{t.commentCount}</span> : null}
          {t.assigneeName ? <Avatar name={t.assigneeName} size="sm" /> : null}
        </span>
      </div>
    </div>
  );
}

export function Board({ projectId, tasks, onOpen }: { projectId: string; tasks: TaskDto[]; onOpen: (id: string) => void }) {
  const { orgId, can } = useOrgContext();
  const m = useProjectMutations(orgId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [title, setTitle] = useState('');
  const canEdit = can('task:update');

  const byStatus = useMemo(() => {
    const map = new Map<TaskStatus, TaskDto[]>(BOARD_COLUMNS.map((s) => [s, []]));
    for (const t of [...tasks].sort((a, b) => a.position - b.position)) map.get(t.status)?.push(t);
    return map;
  }, [tasks]);

  const drop = (status: TaskStatus, beforeId: string | null) => {
    const id = dragId;
    setDragId(null);
    setOver(null);
    if (!id || !canEdit) return;
    const col = (byStatus.get(status) ?? []).filter((t) => t.id !== id);
    const idx = beforeId ? col.findIndex((t) => t.id === beforeId) : -1;
    let position: number;
    if (idx === -1) position = (col.at(-1)?.position ?? 0) + 1000;
    else if (idx === 0) position = col[0]!.position - 1000;
    else position = (col[idx - 1]!.position + col[idx]!.position) / 2;
    const cur = tasks.find((t) => t.id === id);
    if (!cur || (cur.status === status && cur.position === position)) return;
    m.updateTask.mutate({ id, projectId, body: cur.status === status ? { position } : { status, position } });
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4" role="list" aria-label="Task board">
      {BOARD_COLUMNS.map((status) => {
        const col = byStatus.get(status) ?? [];
        return (
          <section
            key={status}
            role="listitem"
            aria-label={TASK_STATUS[status].label}
            onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(status); } }}
            onDragLeave={() => setOver((o) => (o === status ? null : o))}
            onDrop={(e) => { e.preventDefault(); drop(status, null); }}
            className={cn('flex w-72 shrink-0 flex-col rounded-2xl bg-muted/60 p-3 transition-colors', over === status && 'bg-primary-soft ring-2 ring-primary/40')}
          >
            <header className="mb-3 flex items-center gap-2 px-1">
              <span className={cn('h-2 w-2 rounded-full', TASK_STATUS[status].bar)} aria-hidden />
              <h3 className="text-sm font-semibold">{TASK_STATUS[status].label}</h3>
              <span className="rounded-full bg-card px-2 text-xs text-muted-foreground">{col.length}</span>
            </header>
            <div className="flex min-h-[40px] flex-1 flex-col gap-2">
              {col.map((t) => (
                <Card_ key={t.id} t={t} draggable={canEdit} onOpen={() => onOpen(t.id)} onDragStart={() => setDragId(t.id)} onDropOn={() => drop(status, t.id)} />
              ))}
              {col.length === 0 ? <p className="px-2 py-3 text-center text-xs text-muted-foreground">No tasks</p> : null}
            </div>
            {can('task:create') ? (
              adding === status ? (
                <form
                  className="mt-2 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = title.trim();
                    if (!t) return;
                    m.createTask.mutate({ projectId, body: { title: t, status } }, { onSuccess: () => setTitle('') });
                  }}
                >
                  <Input autoFocus aria-label={`New task in ${TASK_STATUS[status].label}`} placeholder="Task title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(null)} />
                  <div className="flex gap-2">
                    <Button size="sm" type="submit" loading={m.createTask.isPending} disabled={!title.trim()}>Add</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setAdding(null); setTitle(''); }}>Cancel</Button>
                  </div>
                </form>
              ) : (
                <button type="button" onClick={() => { setAdding(status); setTitle(''); }} className="mt-2 flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-card hover:text-foreground">
                  <Plus className="h-4 w-4" aria-hidden /> Add task
                </button>
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- List

export function ListView({ projectId, tasks, onOpen }: { projectId: string; tasks: TaskDto[]; onOpen: (id: string) => void }) {
  const { orgId, can } = useOrgContext();
  const m = useProjectMutations(orgId);
  const canEdit = can('task:update');
  if (tasks.length === 0) return <Card><EmptyState icon={<ListChecks className="h-5 w-5" />} title="No tasks match" description="Try clearing filters or add a task from the board." /></Card>;
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0 pb-2">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-3 pl-5 pr-3 font-medium">Task</th>
              <th className="px-3 font-medium">Status</th>
              <th className="px-3 font-medium">Priority</th>
              <th className="px-3 font-medium">Assignee</th>
              <th className="py-3 pl-3 pr-5 font-medium">Due</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="border-t border-border hover:bg-muted/40">
                <td className="py-2.5 pl-5 pr-3">
                  <button type="button" className="flex items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded" onClick={() => onOpen(t.id)}>
                    <span className="font-mono text-xs text-muted-foreground">{t.identifier}</span>
                    <span className={cn('font-medium', t.status === 'DONE' && 'text-muted-foreground line-through')}>{t.title}</span>
                    {t.openBlockers > 0 ? <Lock className="h-3.5 w-3.5 text-warning" aria-label="Blocked" /> : null}
                  </button>
                </td>
                <td className="px-3">
                  {canEdit ? (
                    <Select aria-label={`Status of ${t.identifier}`} className="h-8 w-36 text-xs" value={t.status} onChange={(e) => m.updateTask.mutate({ id: t.id, projectId, body: { status: e.target.value as TaskStatus } })}>
                      {ALL_TASK_STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS[s].label}</option>)}
                    </Select>
                  ) : <Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge>}
                </td>
                <td className="px-3"><Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge></td>
                <td className="px-3">
                  {t.assigneeName ? <span className="flex items-center gap-2"><Avatar name={t.assigneeName} size="sm" />{t.assigneeName}</span> : <span className="text-muted-foreground">Unassigned</span>}
                </td>
                <td className="py-2.5 pl-3 pr-5"><DueLabel t={t} />{!t.dueDate ? <span className="text-muted-foreground">—</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Timeline

const DAY = 32;
const dayDiff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 86_400_000);

export function Timeline({ projectId, tasks, onOpen }: { projectId: string; tasks: TaskDto[]; onOpen: (id: string) => void }) {
  const { orgId } = useOrgContext();
  const milestones = useMilestones(orgId, projectId);
  const dated = tasks.filter((t) => t.startDate || t.dueDate).sort((a, b) => (a.startDate ?? a.dueDate!).localeCompare(b.startDate ?? b.dueDate!));
  const ms = (milestones.data ?? []).filter((x) => x.dueDate);

  if (dated.length === 0 && ms.length === 0) {
    return <Card><EmptyState icon={<CalendarClock className="h-5 w-5" />} title="Nothing to plot yet" description="Give tasks a start and due date (or add milestones) and they’ll appear here." /></Card>;
  }

  const today = new Date(new Date().setHours(0, 0, 0, 0));
  const stamps = [today, ...dated.flatMap((t) => [t.startDate, t.dueDate].filter(Boolean).map((d) => parseDay(d!))), ...ms.map((x) => parseDay(x.dueDate!))];
  const min = new Date(Math.min(...stamps.map((d) => d.getTime())));
  const max = new Date(Math.max(...stamps.map((d) => d.getTime())));
  const start = new Date(min); start.setDate(start.getDate() - 3);
  const days = dayDiff(max, start) + 8;
  const cols = Array.from({ length: days }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  const x = (d: Date) => dayDiff(d, start) * DAY;
  const width = days * DAY;
  const todayX = x(today) + DAY / 2;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-[220px_1fr]">
          <div className="border-r border-border">
            <div className="h-12 border-b border-border" />
            {ms.map((x_) => <div key={x_.id} className="flex h-10 items-center gap-2 truncate border-b border-border px-4 text-sm font-medium"><Flag className="h-3.5 w-3.5 text-primary" aria-hidden />{x_.name}</div>)}
            {dated.map((t) => (
              <button key={t.id} type="button" onClick={() => onOpen(t.id)} className="flex h-10 w-full items-center gap-2 truncate border-b border-border px-4 text-left text-sm hover:bg-muted/50">
                <span className="font-mono text-[11px] text-muted-foreground">{t.identifier}</span><span className="truncate">{t.title}</span>
              </button>
            ))}
          </div>
          <div className="overflow-x-auto" tabIndex={0} aria-label="Timeline, scrollable">
            <div className="relative" style={{ width }}>
              <div className="flex h-12 border-b border-border">
                {cols.map((d, i) => (
                  <div key={i} style={{ width: DAY }} className={cn('flex shrink-0 flex-col items-center justify-end pb-1 text-[10px] text-muted-foreground', d.getDay() === 0 || d.getDay() === 6 ? 'bg-muted/50' : '')}>
                    {d.getDate() === 1 || i === 0 ? <span className="font-semibold text-foreground">{d.toLocaleDateString(undefined, { month: 'short' })}</span> : null}
                    <span>{d.getDate()}</span>
                  </div>
                ))}
              </div>
              <div className="pointer-events-none absolute bottom-0 top-12 w-px bg-primary/60" style={{ left: todayX }} aria-hidden />
              {ms.map((m_) => (
                <div key={m_.id} className="relative h-10 border-b border-border">
                  <Diamond className={cn('absolute top-2.5 h-5 w-5', m_.status === 'COMPLETED' ? 'fill-emerald-500 text-emerald-500' : 'fill-primary text-primary')} style={{ left: x(parseDay(m_.dueDate!)) + 6 }} aria-label={`${m_.name} due ${formatDay(m_.dueDate)}`} />
                </div>
              ))}
              {dated.map((t) => {
                const s = parseDay((t.startDate ?? t.dueDate)!);
                const e = parseDay((t.dueDate ?? t.startDate)!);
                const w = (Math.max(dayDiff(e, s), 0) + 1) * DAY - 4;
                return (
                  <div key={t.id} className="relative h-10 border-b border-border">
                    <button
                      type="button"
                      onClick={() => onOpen(t.id)}
                      title={`${t.title} · ${formatDay(t.startDate)} → ${formatDay(t.dueDate)}`}
                      className={cn('absolute top-2 flex h-6 items-center gap-1 overflow-hidden rounded-md px-2 text-xs font-medium text-white shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', TASK_STATUS[t.status].bar, isOverdue(t.dueDate, t.status) && 'ring-2 ring-destructive')}
                      style={{ left: x(s) + 2, width: w }}
                    >
                      {t.openBlockers > 0 ? <Lock className="h-3 w-3 shrink-0" aria-label="Blocked" /> : null}
                      <span className="truncate">{t.title}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Milestones

export function MilestonesPanel({ projectId }: { projectId: string }) {
  const { orgId, can } = useOrgContext();
  const list = useMilestones(orgId, projectId);
  const m = useProjectMutations(orgId);
  const [name, setName] = useState('');
  const [due, setDue] = useState('');
  const canEdit = can('project:update');

  return (
    <div className="space-y-4">
      {canEdit ? (
        <Card>
          <CardContent className="pt-5">
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                m.createMilestone.mutate({ projectId, body: { name: name.trim(), dueDate: due || null } }, { onSuccess: () => { setName(''); setDue(''); } });
              }}
            >
              <Input aria-label="Milestone name" placeholder="New milestone, e.g. Beta release" value={name} onChange={(e) => setName(e.target.value)} />
              <Input aria-label="Milestone due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="sm:w-44" />
              <Button type="submit" disabled={!name.trim()} loading={m.createMilestone.isPending}><Plus className="h-4 w-4" aria-hidden /> Add</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {list.isPending ? <Skeleton className="h-24 w-full" /> : (list.data ?? []).length === 0 ? (
        <Card><EmptyState icon={<Flag className="h-5 w-5" />} title="No milestones yet" description="Milestones group tasks around key delivery dates." /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.data!.map((ms: MilestoneDto) => (
            <Card key={ms.id} className="p-5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold">{ms.name}</h3>
                  <p className="text-xs text-muted-foreground">{ms.dueDate ? `Due ${formatDay(ms.dueDate)}` : 'No due date'} · {ms.doneCount}/{ms.taskCount} tasks</p>
                </div>
                {ms.status === 'COMPLETED' ? <Badge tone="success"><CheckCircle2 className="h-3 w-3" aria-hidden /> Completed</Badge> : <Badge tone="primary">Open</Badge>}
              </div>
              <div className="mt-3"><ProgressBar done={ms.doneCount} total={ms.taskCount} /></div>
              {canEdit ? (
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => m.updateMilestone.mutate({ id: ms.id, projectId, body: { status: ms.status === 'OPEN' ? 'COMPLETED' : 'OPEN' } })}>
                    {ms.status === 'OPEN' ? 'Mark completed' : 'Reopen'}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" aria-label={`Delete milestone ${ms.name}`} onClick={() => m.deleteMilestone.mutate({ id: ms.id, projectId })}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Activity

export function ActivityPanel({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const { orgId } = useOrgContext();
  const feed = useProjectActivity(orgId, projectId);
  const members = useWorkspaceMembers(orgId, workspaceId);
  const name = (id: string | null) => (members.data ?? []).find((u) => u.userId === id)?.name ?? 'Someone';
  return (
    <Card>
      <CardHeader title="Project activity" description="Latest changes by your team." />
      <CardContent>
        {feed.isPending ? <Skeleton className="h-24 w-full" /> : (feed.data ?? []).length === 0 ? (
          <EmptyState title="No activity yet" />
        ) : (
          <ul className="divide-y divide-border">
            {feed.data!.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                <Avatar name={name(a.actorId)} size="sm" />
                <p className="min-w-0 flex-1 truncate text-sm"><span className="font-medium">{name(a.actorId)}</span> <span className="text-muted-foreground">{activityText(a.action, a.metadata)}</span></p>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={a.createdAt}>{timeAgo(a.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
