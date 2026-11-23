import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';

/** Queues fed by the outbox relay (one job per event). */
export const RELAY_QUEUES = ['email', 'notifications', 'knowledge', 'meetings', 'integrations'] as const;
export type QueueName = (typeof RELAY_QUEUES)[number];
export const MAINTENANCE_QUEUE = 'maintenance';
export const DEAD_LETTER_QUEUE = 'dead-letter';

export interface JobData {
  eventId: string;
  type: string;
  payload: unknown;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: false, // keep failures for inspection; terminal ones are also copied to the dead-letter queue
};

export function createQueues(connection: ConnectionOptions, prefix?: string) {
  const opts = { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS };
  return {
    email: new Queue<JobData>('email', opts),
    notifications: new Queue<JobData>('notifications', opts),
    knowledge: new Queue<JobData>('knowledge', opts),
    meetings: new Queue<JobData>('meetings', opts),
    integrations: new Queue<JobData>('integrations', opts),
    maintenance: new Queue<Record<string, never>>(MAINTENANCE_QUEUE, { connection, prefix, defaultJobOptions: { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } } }),
    deadLetter: new Queue(DEAD_LETTER_QUEUE, { connection, prefix }),
  };
}
