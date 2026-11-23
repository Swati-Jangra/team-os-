import { describe, expect, it } from 'vitest';
import { actionHash, addDays, analyzeRisks, canonicalJson, computeSlip, type RiskTask } from './index';

const t = (id: string, due: string | null, status = 'TODO', assigneeId: string | null = 'u1'): RiskTask => ({ id, identifier: `T-${id}`, title: id, status, dueDate: due, assigneeId });
const today = '2026-11-18';

describe('risk engine', () => {
  it('flags overdue work as FACT and propagates slip downstream as INFERRED', () => {
    const tasks = [t('a', '2026-11-13'), t('b', '2026-11-20'), t('c', '2026-11-25'), t('d', '2026-11-30', 'DONE')];
    const deps = [{ taskId: 'b', dependsOnTaskId: 'a' }, { taskId: 'c', dependsOnTaskId: 'b' }, { taskId: 'd', dependsOnTaskId: 'a' }];
    const f = analyzeRisks({ tasks, dependencies: deps, today });
    const a = f.find((x) => x.taskId === 'a')!;
    expect(a).toMatchObject({ kind: 'OVERDUE', basis: 'FACT', severity: 'HIGH', slipDays: 5 });
    expect(a.relatedTaskIds.sort()).toEqual(['b', 'c']); // finished tasks are not "affected"
    expect(f.find((x) => x.taskId === 'c')).toMatchObject({ kind: 'BLOCKED_BY_LATE', basis: 'INFERRED', slipDays: 5 });
    expect(f.find((x) => x.taskId === 'c')!.recommendation).toContain('2026-11-30');
    expect(f.find((x) => x.taskId === 'd')).toBeUndefined();
  });
  it('detects date conflicts, unassigned work, and project deadline risk', () => {
    const tasks = [t('a', '2026-11-25'), t('b', '2026-11-22'), t('c', '2026-11-20', 'TODO', null), t('e', '2026-12-10')];
    const f = analyzeRisks({ tasks, dependencies: [{ taskId: 'b', dependsOnTaskId: 'a' }], today, projectDueDate: '2026-12-01' });
    expect(f.map((x) => x.kind)).toEqual(expect.arrayContaining(['DATE_CONFLICT', 'UNASSIGNED_DUE_SOON', 'PROJECT_DEADLINE']));
    expect(f.find((x) => x.kind === 'PROJECT_DEADLINE')!.slipDays).toBe(9);
  });
  it('is deterministic, ignores finished tasks, and never loops on a cycle', () => {
    const tasks = [t('a', '2026-11-10'), t('b', '2026-11-12')];
    const deps = [{ taskId: 'a', dependsOnTaskId: 'b' }, { taskId: 'b', dependsOnTaskId: 'a' }];
    expect(analyzeRisks({ tasks, dependencies: deps, today })).toEqual(analyzeRisks({ tasks, dependencies: deps, today }));
    expect(computeSlip({ tasks, dependencies: deps, today }).size).toBe(2);
    expect(analyzeRisks({ tasks: [t('a', '2026-01-01', 'DONE'), t('b', '2026-01-01', 'CANCELLED')], dependencies: [], today })).toEqual([]);
  });
  it('addDays handles month ends', () => expect(addDays('2026-11-30', 1)).toBe('2026-12-01'));
});

describe('action hash', () => {
  it('is stable across key order and changes with any payload change', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    const base = { actionType: 'TASK_UPDATE_DUE', targetTaskId: 'x', payload: { dueDate: '2026-12-01' } };
    expect(actionHash(base)).toBe(actionHash({ payload: { dueDate: '2026-12-01' }, targetTaskId: 'x', actionType: 'TASK_UPDATE_DUE' }));
    expect(actionHash(base)).not.toBe(actionHash({ ...base, payload: { dueDate: '2026-12-02' } }));
    expect(actionHash(base)).not.toBe(actionHash({ ...base, targetTaskId: 'y' }));
  });
});
