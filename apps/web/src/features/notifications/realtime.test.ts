import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatcher, keysForHint } from './realtime';

describe('keysForHint', () => {
  it('maps task hints to the project, task and my-tasks queries', () => {
    const keys = keysForHint('o1', { type: 'task.updated', projectId: 'p1', taskId: 't1', workspaceId: 'w1' });
    expect(keys).toContainEqual(['org', 'o1', 'projects', 'p1']);
    expect(keys).toContainEqual(['org', 'o1', 'task', 't1']);
    expect(keys).toContainEqual(['org', 'o1', 'my-tasks']);
  });
  it('maps document hints to the list and the document', () => {
    const keys = keysForHint('o1', { type: 'document.updated', documentId: 'd1', workspaceId: 'w1' });
    expect(keys).toContainEqual(['org', 'o1', 'documents']);
    expect(keys).toContainEqual(['org', 'o1', 'document', 'd1']);
  });
  it('refreshes calendar and email lists on Google hints', () => {
    expect(keysForHint('o1', { type: 'calendar.synced' })).toContainEqual(['org', 'o1', 'calendar']);
    expect(keysForHint('o1', { type: 'email.processed' })).toContainEqual(['org', 'o1', 'emails']);
  });
  it('refreshes integrations and task links on GitHub hints', () => {
    const keys = keysForHint('o1', { type: 'github.pull_request.updated', taskId: 't1' });
    expect(keys).toContainEqual(['org', 'o1', 'integrations']);
    expect(keys).toContainEqual(['org', 'o1', 'task', 't1', 'links']);
  });

  it('maps meeting hints to the list, the meeting and project/task data', () => {
    const keys = keysForHint('o1', { type: 'meeting.processed', meetingId: 'm1' });
    expect(keys).toContainEqual(['org', 'o1', 'meetings']);
    expect(keys).toContainEqual(['org', 'o1', 'meeting', 'm1']);
    expect(keys).toContainEqual(['org', 'o1', 'projects']);
  });
  it('maps agent hints to approvals, risks and (when applied) real tasks', () => {
    const k = keysForHint('o1', { type: 'agent.action.completed', agentActionId: 'a1' });
    expect(k).toContainEqual(['org', 'o1', 'agent-actions']);
    expect(k).toContainEqual(['org', 'o1', 'risks']);
    expect(k).toContainEqual(['org', 'o1', 'projects']);
    expect(keysForHint('o1', { type: 'agent.action.proposed' })).not.toContainEqual(['org', 'o1', 'projects']);
    expect(keysForHint('o1', { type: 'task.updated', taskId: 't' })).toContainEqual(['org', 'o1', 'risks']);
  });
  it('maps member and workspace hints, ignores unknown types', () => {
    expect(keysForHint('o1', { type: 'member.removed' })).toContainEqual(['org', 'o1', 'members']);
    expect(keysForHint('o1', { type: 'workspace.created' })).toContainEqual(['org', 'o1', 'workspaces']);
    expect(keysForHint('o1', { type: 'something.else' })).toEqual([]);
  });
});

describe('createBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('coalesces a burst into one flush with distinct keys', () => {
    const flush = vi.fn();
    const b = createBatcher(flush, 150);
    b.add([['a'], ['b']]);
    b.add([['a']]);
    vi.advanceTimersByTime(149);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]![0]).toHaveLength(2);
  });
  it('cancel drops pending work', () => {
    const flush = vi.fn();
    const b = createBatcher(flush);
    b.add([['a']]);
    b.cancel();
    vi.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled();
  });
});
