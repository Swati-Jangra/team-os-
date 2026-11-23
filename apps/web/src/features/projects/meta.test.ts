import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityText, formatDay, isOverdue, parseDay, percent, toIsoDay } from './meta';

afterEach(() => vi.useRealTimers());

describe('project helpers', () => {
  it('computes progress safely', () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(1, 3)).toBe(33);
    expect(percent(3, 3)).toBe(100);
  });
  it('parses YYYY-MM-DD as a local calendar day (no timezone shift)', () => {
    const d = parseDay('2026-06-01');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 5, 1]);
    expect(toIsoDay(d)).toBe('2026-06-01');
    expect(formatDay(null)).toBe('—');
  });
  it('flags overdue only for open tasks with a past due date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 10, 15, 0, 0));
    expect(isOverdue('2026-06-09', 'TODO')).toBe(true);
    expect(isOverdue('2026-06-10', 'TODO')).toBe(false); // due today is not overdue
    expect(isOverdue('2026-06-09', 'DONE')).toBe(false);
    expect(isOverdue('2026-06-09', 'CANCELLED')).toBe(false);
    expect(isOverdue(null, 'TODO')).toBe(false);
  });
  it('describes activity', () => {
    expect(activityText('task.status_changed', { from: 'TODO', to: 'DONE' })).toBe('moved the task from To do to Done');
    expect(activityText('task.updated', { fields: ['dueDate', 'priority'] })).toBe('updated the task (due date, priority)');
    expect(activityText('task.created', { title: 'Ship it' })).toBe('created “Ship it”');
    expect(activityText('something.unknown', {})).toBe('something.unknown');
  });
});
