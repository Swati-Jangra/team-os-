import { describe, expect, it } from 'vitest';
import { createProjectSchema, createTaskSchema, updateTaskSchema, projectKeySchema, commentBodySchema } from './project';

const uuid = '3f2c1c1e-8a4b-4a52-9d1e-0b1e5c2f7a10';

describe('project schemas', () => {
  it('normalizes keys to upper case and rejects bad ones', () => {
    expect(projectKeySchema.parse(' web ')).toBe('WEB');
    for (const k of ['1ab', 'a', 'toolongkey123', 'a-b']) expect(projectKeySchema.safeParse(k).success).toBe(false);
  });
  it('requires due date >= start date', () => {
    expect(createProjectSchema.safeParse({ workspaceId: uuid, name: 'x', startDate: '2026-02-02', dueDate: '2026-02-01' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ workspaceId: uuid, name: 'x', startDate: '2026-02-01', dueDate: '2026-02-01' }).success).toBe(true);
  });
  it('rejects impossible dates and malformed formats', () => {
    expect(createTaskSchema.safeParse({ title: 't', dueDate: '2026-13-45' }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: 't', dueDate: '01/02/2026' }).success).toBe(false);
  });
  it('limits labels, estimate and requires a non-empty patch', () => {
    expect(createTaskSchema.safeParse({ title: 't', labels: Array(11).fill('a') }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: 't', estimateHours: -1 }).success).toBe(false);
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
    expect(updateTaskSchema.safeParse({ position: 1500.5 }).success).toBe(true);
  });
  it('trims comments and rejects blanks', () => {
    expect(commentBodySchema.parse({ body: '  hi  ' }).body).toBe('hi');
    expect(commentBodySchema.safeParse({ body: '   ' }).success).toBe(false);
  });
});
