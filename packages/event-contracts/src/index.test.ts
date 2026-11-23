import { describe, expect, it } from 'vitest';
import { EVENT_QUEUE, EVENT_TYPES, isEventType, parseEventPayload } from './index';

describe('event contracts', () => {
  it('validates payloads', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(parseEventPayload('org.created.v1', { organizationId: id, name: 'Acme', ownerUserId: id }).name).toBe('Acme');
    expect(() => parseEventPayload('org.created.v1', { organizationId: 'nope' })).toThrow();
  });

  it('every queue mapping refers to a known event type', () => {
    for (const t of Object.keys(EVENT_QUEUE)) expect(isEventType(t)).toBe(true);
  });

  it('all event types are versioned', () => {
    for (const t of EVENT_TYPES) expect(t).toMatch(/\.v\d+$/);
  });
});

import { toRealtimeHint, EVENT_QUEUE } from './index';

describe('realtime hints', () => {
  it('forwards only ids and the bare event type', () => {
    const hint = toRealtimeHint('task.assigned.v1', {
      organizationId: 'o', workspaceId: 'w', projectId: 'p', taskId: 't', title: 'SECRET TITLE', assigneeId: 'a',
    });
    expect(hint).toEqual({ type: 'task.assigned', workspaceId: 'w', projectId: 'p', taskId: 't' });
    expect(JSON.stringify(hint)).not.toContain('SECRET');
  });
  it('never produces a hint for secret-bearing or user-scoped events', () => {
    expect(toRealtimeHint('member.invited.v1', { token: 'abc', organizationId: 'o' })).toBeNull();
    expect(toRealtimeHint('user.password_reset_requested.v1', { token: 'abc' })).toBeNull();
    expect(toRealtimeHint('nonsense.v1', {})).toBeNull();
  });
  it('routes assignment/comment/status events to the notifications queue', () => {
    expect(EVENT_QUEUE['task.assigned.v1']).toBe('notifications');
    expect(EVENT_QUEUE['task.updated.v1']).toBeUndefined();
  });
});
