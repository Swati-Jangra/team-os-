export type ProjectStatus = 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED';
export type TaskStatus = 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; tone: Tone }> = {
  PLANNING: { label: 'Planning', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'primary' },
  ON_HOLD: { label: 'On hold', tone: 'warning' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
};

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone; bar: string }> = {
  BACKLOG: { label: 'Backlog', tone: 'neutral', bar: 'bg-slate-400' },
  TODO: { label: 'To do', tone: 'neutral', bar: 'bg-sky-500' },
  IN_PROGRESS: { label: 'In progress', tone: 'primary', bar: 'bg-primary' },
  IN_REVIEW: { label: 'In review', tone: 'warning', bar: 'bg-amber-500' },
  DONE: { label: 'Done', tone: 'success', bar: 'bg-emerald-500' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', bar: 'bg-slate-300' },
};
export const BOARD_COLUMNS: TaskStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];
export const ALL_TASK_STATUSES = Object.keys(TASK_STATUS) as TaskStatus[];

export const PRIORITY: Record<TaskPriority, { label: string; tone: Tone }> = {
  LOW: { label: 'Low', tone: 'neutral' },
  MEDIUM: { label: 'Medium', tone: 'primary' },
  HIGH: { label: 'High', tone: 'warning' },
  URGENT: { label: 'Urgent', tone: 'danger' },
};
export const PRIORITIES = Object.keys(PRIORITY) as TaskPriority[];

export function percent(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

/** Parse a 'YYYY-MM-DD' string as a LOCAL date (new Date('2026-06-01') is UTC and can show the previous day). */
export function parseDay(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}
export function formatDay(s: string | null | undefined): string {
  return s ? parseDay(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}
export function toIsoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function isOverdue(due: string | null, status: TaskStatus): boolean {
  if (!due || status === 'DONE' || status === 'CANCELLED') return false;
  return parseDay(due).getTime() < new Date().setHours(0, 0, 0, 0);
}

const ACTIVITY: Record<string, string> = {
  'project.created': 'created the project',
  'project.updated': 'updated the project',
  'milestone.created': 'added a milestone',
  'milestone.updated': 'updated a milestone',
  'milestone.deleted': 'removed a milestone',
  'task.created': 'created the task',
  'task.updated': 'updated the task',
  'task.deleted': 'deleted the task',
  'task.status_changed': 'changed the status',
  'task.assigned': 'changed the assignee',
  'task.dependency_added': 'added a dependency',
  'task.dependency_removed': 'removed a dependency',
  'comment.created': 'commented',
};
const FIELD_LABEL: Record<string, string> = {
  title: 'title', description: 'description', priority: 'priority', status: 'status', assigneeId: 'assignee',
  milestoneId: 'milestone', startDate: 'start date', dueDate: 'due date', estimateHours: 'estimate', labels: 'labels', name: 'name', ownerId: 'owner',
};
export function activityText(action: string, meta: Record<string, unknown>): string {
  if (action === 'task.status_changed') {
    const f = TASK_STATUS[meta.from as TaskStatus]?.label ?? String(meta.from);
    const t = TASK_STATUS[meta.to as TaskStatus]?.label ?? String(meta.to);
    return `moved the task from ${f} to ${t}`;
  }
  if ((action === 'task.updated' || action === 'project.updated') && Array.isArray(meta.fields) && meta.fields.length > 0) {
    const names = (meta.fields as string[]).map((f) => FIELD_LABEL[f] ?? f).join(', ');
    return `updated ${action === 'task.updated' ? 'the task' : 'the project'} (${names})`;
  }
  if (action === 'task.created' && typeof meta.title === 'string') return `created “${meta.title}”`;
  return ACTIVITY[action] ?? action;
}
