/**
 * Deterministic schedule-risk engine. Pure functions over a snapshot of tasks + dependencies.
 * Every finding is labelled so people can tell what is known from what is guessed:
 *   FACT      - directly true in the data (a task is overdue, a due date contradicts its dependency)
 *   INFERRED  - derived by propagating facts (downstream work will probably slip)
 * and carries a plain-language recommendation. There is no model in here: same input, same output.
 */
export interface RiskTask {
  id: string;
  identifier: string;
  title: string;
  status: string; // DONE and CANCELLED count as finished
  dueDate: string | null; // YYYY-MM-DD
  assigneeId: string | null;
}
export interface RiskDependency {
  taskId: string; // the blocked task
  dependsOnTaskId: string; // the blocker
}
export type RiskKind = 'OVERDUE' | 'BLOCKED_BY_LATE' | 'DATE_CONFLICT' | 'UNASSIGNED_DUE_SOON' | 'PROJECT_DEADLINE';
export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export interface RiskFinding {
  kind: RiskKind;
  basis: 'FACT' | 'INFERRED';
  severity: RiskSeverity;
  taskId: string | null;
  identifier: string | null;
  message: string;
  recommendation: string;
  /** task ids that explain the finding (blockers, affected downstream work) */
  relatedTaskIds: string[];
  /** days of expected slip, where meaningful */
  slipDays?: number;
}
export interface RiskInput {
  tasks: RiskTask[];
  dependencies: RiskDependency[];
  today: string; // YYYY-MM-DD (UTC)
  projectDueDate?: string | null;
  soonDays?: number;
}

const DAY = 86_400_000;
export const isFinished = (status: string) => status === 'DONE' || status === 'CANCELLED';
export const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
export const addDays = (iso: string, n: number) => new Date((dayNumber(iso) + n) * DAY).toISOString().slice(0, 10);

/** Expected slip (days) per open task: its own lateness, or the worst slip among the tasks that block it. */
export function computeSlip(input: Pick<RiskInput, 'tasks' | 'dependencies' | 'today'>): Map<string, { own: number; slip: number; causes: string[] }> {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const blockers = new Map<string, string[]>();
  for (const d of input.dependencies) {
    if (!byId.has(d.taskId) || !byId.has(d.dependsOnTaskId)) continue;
    (blockers.get(d.taskId) ?? blockers.set(d.taskId, []).get(d.taskId)!).push(d.dependsOnTaskId);
  }
  const out = new Map<string, { own: number; slip: number; causes: string[] }>();
  const visiting = new Set<string>();
  const visit = (id: string): { own: number; slip: number; causes: string[] } => {
    const known = out.get(id);
    if (known) return known;
    const t = byId.get(id)!;
    if (isFinished(t.status)) {
      const r = { own: 0, slip: 0, causes: [] };
      out.set(id, r);
      return r;
    }
    if (visiting.has(id)) return { own: 0, slip: 0, causes: [] }; // cycles are rejected by the API; never loop on bad data
    visiting.add(id);
    const own = t.dueDate && t.dueDate < input.today ? dayNumber(input.today) - dayNumber(t.dueDate) : 0;
    let slip = own;
    let causes: string[] = own > 0 ? [id] : [];
    for (const b of blockers.get(id) ?? []) {
      const r = visit(b);
      if (r.slip > slip) {
        slip = r.slip;
        causes = r.causes;
      } else if (r.slip === slip && r.slip > 0) causes = [...new Set([...causes, ...r.causes])];
    }
    visiting.delete(id);
    const res = { own, slip, causes };
    out.set(id, res);
    return res;
  };
  for (const t of input.tasks) visit(t.id);
  return out;
}

const SEV: Record<RiskSeverity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export function analyzeRisks(input: RiskInput): RiskFinding[] {
  const { tasks, dependencies, today } = input;
  const soon = input.soonDays ?? 7;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const slip = computeSlip(input);
  const dependents = new Map<string, string[]>();
  for (const d of dependencies) (dependents.get(d.dependsOnTaskId) ?? dependents.set(d.dependsOnTaskId, []).get(d.dependsOnTaskId)!).push(d.taskId);
  const downstreamOf = (id: string): string[] => {
    const seen = new Set<string>();
    const stack = [...(dependents.get(id) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n) || n === id) continue;
      const t = byId.get(n);
      if (!t || isFinished(t.status)) continue;
      seen.add(n);
      stack.push(...(dependents.get(n) ?? []));
    }
    return [...seen];
  };

  const findings: RiskFinding[] = [];
  for (const t of tasks) {
    if (isFinished(t.status)) continue;
    const s = slip.get(t.id)!;
    if (s.own > 0) {
      const down = downstreamOf(t.id);
      findings.push({
        kind: 'OVERDUE', basis: 'FACT', severity: down.length > 0 || s.own >= 7 ? 'HIGH' : 'MEDIUM', taskId: t.id, identifier: t.identifier,
        message: `${t.identifier} is ${s.own} day${s.own === 1 ? '' : 's'} overdue (due ${t.dueDate})${down.length ? ` and ${down.length} open task${down.length === 1 ? '' : 's'} depend on it` : ''}.`,
        recommendation: down.length ? 'Finish it or agree a new date, then move the dependent tasks.' : 'Finish it or agree a new date.',
        relatedTaskIds: down, slipDays: s.own,
      });
    } else if (s.slip > 0) {
      const causes = s.causes.map((c) => byId.get(c)?.identifier ?? c);
      findings.push({
        kind: 'BLOCKED_BY_LATE', basis: 'INFERRED', severity: s.slip >= 7 ? 'HIGH' : 'MEDIUM', taskId: t.id, identifier: t.identifier,
        message: `${t.identifier} is likely to slip about ${s.slip} day${s.slip === 1 ? '' : 's'} because ${causes.join(', ')} ${causes.length === 1 ? 'is' : 'are'} late and block${causes.length === 1 ? 's' : ''} it.`,
        recommendation: t.dueDate ? `Consider moving its due date from ${t.dueDate} to ${addDays(t.dueDate, s.slip)}.` : 'Set a realistic due date once the blocker is resolved.',
        relatedTaskIds: s.causes, slipDays: s.slip,
      });
    }
    // an open task due before something it depends on is due (and the blocker is unfinished)
    for (const d of dependencies.filter((x) => x.taskId === t.id)) {
      const b = byId.get(d.dependsOnTaskId);
      if (!b || isFinished(b.status) || !t.dueDate || !b.dueDate) continue;
      if (t.dueDate < b.dueDate) {
        findings.push({
          kind: 'DATE_CONFLICT', basis: 'FACT', severity: 'MEDIUM', taskId: t.id, identifier: t.identifier,
          message: `${t.identifier} is due ${t.dueDate}, before its blocker ${b.identifier} (due ${b.dueDate}).`,
          recommendation: `Move ${t.identifier} to ${b.dueDate} or later, or bring ${b.identifier} forward.`, relatedTaskIds: [b.id],
        });
      }
    }
    if (!t.assigneeId && t.dueDate && t.dueDate <= addDays(today, soon) && t.dueDate >= today) {
      findings.push({
        kind: 'UNASSIGNED_DUE_SOON', basis: 'FACT', severity: t.dueDate <= addDays(today, 2) ? 'HIGH' : 'MEDIUM', taskId: t.id, identifier: t.identifier,
        message: `${t.identifier} is due ${t.dueDate} and has no assignee.`, recommendation: 'Assign an owner.', relatedTaskIds: [],
      });
    }
  }

  if (input.projectDueDate) {
    let worst: { id: string; finish: string } | null = null;
    for (const t of tasks) {
      if (isFinished(t.status) || !t.dueDate) continue;
      const finish = addDays(t.dueDate, slip.get(t.id)?.slip ?? 0);
      if (!worst || finish > worst.finish) worst = { id: t.id, finish };
    }
    if (worst && worst.finish > input.projectDueDate) {
      const late = dayNumber(worst.finish) - dayNumber(input.projectDueDate);
      const t = byId.get(worst.id)!;
      findings.push({
        kind: 'PROJECT_DEADLINE', basis: 'INFERRED', severity: late >= 7 ? 'HIGH' : 'MEDIUM', taskId: null, identifier: null,
        message: `Projected finish of ${t.identifier} (${worst.finish}) is ${late} day${late === 1 ? '' : 's'} after the project due date (${input.projectDueDate}).`,
        recommendation: 'Re-plan, add capacity, or agree a new project date.', relatedTaskIds: [worst.id], slipDays: late,
      });
    }
  }
  return findings.sort((a, b) => SEV[b.severity] - SEV[a.severity] || (a.identifier ?? '').localeCompare(b.identifier ?? ''));
}
