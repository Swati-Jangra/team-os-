'use client';
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from '@teamos/ui';
import { nk } from './api';

/** Mirrors the server's RealtimeHint: ids and an event type, never content. */
export interface Hint {
  type: string;
  workspaceId?: string;
  projectId?: string;
  taskId?: string;
  documentId?: string;
  meetingId?: string;
  agentActionId?: string;
}

type Key = readonly unknown[];

/** Which cached queries a hint makes stale. Pure, so it can be unit-tested. */
export function keysForHint(orgId: string, h: Hint): Key[] {
  const o = ['org', orgId] as const;
  const keys: Key[] = [];
  if (h.type.startsWith('task.') || h.type.startsWith('milestone.') || h.type.startsWith('project.')) {
    keys.push([...o, 'projects'], [...o, 'my-tasks']);
    if (h.projectId) keys.push([...o, 'projects', h.projectId]);
    if (h.taskId) keys.push([...o, 'task', h.taskId]);
    else keys.push([...o, 'task']);
  }
  if (h.type.startsWith('document.')) {
    keys.push([...o, 'documents']);
    if (h.documentId) keys.push([...o, 'document', h.documentId]);
  }
  if (h.type.startsWith('meeting.')) {
    keys.push([...o, 'meetings']);
    if (h.meetingId) keys.push([...o, 'meeting', h.meetingId]);
    // an approved action item creates a task
    keys.push([...o, 'projects'], [...o, 'my-tasks']);
  }
  if (h.type.startsWith('agent.')) {
    keys.push([...o, 'agent-actions'], [...o, 'risks']);
    // an applied action changes real tasks
    if (h.type === 'agent.action.completed') keys.push([...o, 'projects'], [...o, 'my-tasks'], [...o, 'task']);
  }
  // task/project changes change the risk picture
  if (h.type.startsWith('task.') || h.type.startsWith('project.')) keys.push([...o, 'risks']);
  if (h.type.startsWith('integration.') || h.type.startsWith('github.')) {
    keys.push([...o, 'integrations']);
    if (h.taskId) keys.push([...o, 'task', h.taskId, 'links']);
    else keys.push([...o, 'task']);
  }
  if (h.type === 'calendar.synced' || h.type === 'integration.google_sync_requested') keys.push([...o, 'calendar'], [...o, 'google']);
  if (h.type === 'email.processed') keys.push([...o, 'emails']);
  if (h.type.startsWith('workspace.')) keys.push([...o, 'workspaces']);
  if (h.type.startsWith('member.')) keys.push([...o, 'members'], [...o, 'workspaces']);
  return keys;
}

/** Collects invalidations for `delayMs` and flushes each distinct key once (a burst of events = one refetch). */
export function createBatcher(flush: (keys: Key[]) => void, delayMs = 150) {
  const pending = new Map<string, Key>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    add(keys: Key[]) {
      for (const k of keys) pending.set(JSON.stringify(k), k);
      if (!timer && pending.size) {
        timer = setTimeout(() => {
          timer = undefined;
          const out = [...pending.values()];
          pending.clear();
          flush(out);
        }, delayMs);
      }
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

export function invalidateKeys(qc: QueryClient, keys: Key[]) {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

/**
 * Subscribes to the org's live stream. Hints only trigger refetches through the normal, authorized API;
 * nothing from the stream is rendered directly except the user's own notification titles.
 */
export function useRealtime(orgId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const batcher = createBatcher((keys) => invalidateKeys(qc, keys));
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let opened = false;

    const connect = () => {
      es = new EventSource(`/api/v1/organizations/${orgId}/stream`, { withCredentials: true });
      es.addEventListener('ready', () => {
        // After a reconnect we may have missed events: refetch everything for this org once.
        if (opened) invalidateKeys(qc, [['org', orgId]]);
        opened = true;
      });
      es.addEventListener('hint', (e) => {
        try {
          batcher.add(keysForHint(orgId, JSON.parse((e as MessageEvent<string>).data) as Hint));
        } catch {
          /* ignore malformed */
        }
      });
      es.addEventListener('notification', (e) => {
        try {
          const n = JSON.parse((e as MessageEvent<string>).data) as { title: string };
          toast(n.title);
        } catch {
          /* ignore malformed */
        }
        void qc.invalidateQueries({ queryKey: nk.all(orgId) });
      });
      es.addEventListener('close', () => {
        // Server ended the stream deliberately (session ended / access revoked): stop, don't hammer it.
        stopped = true;
        es?.close();
        void qc.invalidateQueries({ queryKey: ['me'] });
      });
      es.onerror = () => {
        // EventSource retries by itself while CONNECTING; if it gave up (CLOSED, e.g. a 401/404), back off manually.
        if (es?.readyState === EventSource.CLOSED && !stopped) {
          retry = setTimeout(connect, 10_000);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      batcher.cancel();
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [orgId, qc]);
}
