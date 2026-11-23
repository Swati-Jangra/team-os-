import type { MeetingStatus } from './api';

export const MEETING_STATUS: Record<MeetingStatus, { label: string; tone: 'neutral' | 'primary' | 'success' | 'danger' }> = {
  DRAFT: { label: 'Not processed', tone: 'neutral' },
  PROCESSING: { label: 'Processing…', tone: 'primary' },
  READY: { label: 'Ready for review', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
};
