import type { ExternalItemDto, IntegrationStatus } from './api';

export const KIND_LABEL: Record<ExternalItemDto['kind'], string> = { PULL_REQUEST: 'Pull request', ISSUE: 'Issue', COMMIT: 'Commit' };
export const STATUS_LABEL: Record<IntegrationStatus, { label: string; tone: 'success' | 'danger' | 'neutral' }> = {
  CONNECTED: { label: 'Connected', tone: 'success' },
  ERROR: { label: 'Needs reconnecting', tone: 'danger' },
  DISCONNECTED: { label: 'Disconnected', tone: 'neutral' },
};
/** `#12` for PRs/issues, the short sha for commits. */
export const itemRef = (i: { kind: ExternalItemDto['kind']; externalId: string }) => (i.kind === 'COMMIT' ? i.externalId.slice(0, 7) : `#${i.externalId}`);
export const STATE_TONE: Record<string, 'success' | 'primary' | 'neutral'> = { open: 'success', merged: 'primary', closed: 'neutral' };
/** Only ever link out to https GitHub URLs we stored; anything else renders as plain text. */
export const safeUrl = (u: string): string | null => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch {
    return null;
  }
};
