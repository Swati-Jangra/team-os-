import type { ActionStatus, AgentAction } from './api';

export const ACTION_STATUS: Record<ActionStatus, { label: string; tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  PENDING: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'primary' },
  EXECUTING: { label: 'Applying…', tone: 'primary' },
  EXECUTED: { label: 'Applied', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'danger' },
  STALE: { label: 'Out of date', tone: 'warning' },
};
export const ACTION_TITLE: Record<AgentAction['actionType'], string> = { TASK_UPDATE_DUE: 'Change due date', TASK_ASSIGN: 'Assign task' };
export const AGENT_LABEL: Record<AgentAction['agent'], string> = { DEPENDENCY_RISK: 'Dependency Risk Agent', TASK_MANAGEMENT: 'Task Management Agent' };
export const SEVERITY_TONE = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' } as const;
export const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'PENDING', label: 'Waiting' }, { value: 'EXECUTED', label: 'Applied' }, { value: 'REJECTED', label: 'Rejected' },
  { value: 'FAILED', label: 'Failed' }, { value: 'STALE', label: 'Out of date' }, { value: 'EXPIRED', label: 'Expired' }, { value: '', label: 'All' },
];
