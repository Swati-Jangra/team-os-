import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { loadEnv } from '@teamos/config';
import { createDb } from '@teamos/database';
import { createProvider } from '@teamos/ai-core';
import { createMeetingProcessor } from './meeting.processor';
import { createKnowledgeProcessor } from './knowledge.processor';
import { createEmailProcessor } from './email.processor';
import { GitHubClient, GoogleClient, parseEncryptionKey } from '@teamos/integrations';
import type { GoogleDeps } from './google.processor';
import { createIntegrationProcessor, type IntegrationDeps } from './integration.processor';
import { createMaintenanceProcessor } from './maintenance';
import { createNotificationProcessor } from './notification.processor';
import { RedisPublisher } from './realtime';
import { SmtpMailer } from './mailer';
import { DEAD_LETTER_QUEUE, MAINTENANCE_QUEUE, createQueues, type JobData } from './queues';
import { runRelayLoop } from './relay';
import { createWorkerObservability } from './observability';

async function main(): Promise<void> {
  const env = loadEnv();
  const log = (m: string) => console.log(`[worker] ${m}`);
  const db = createDb(env.DATABASE_URL, { max: 5 });
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queues = createQueues(connection);
  const deadLetter = new Queue(DEAD_LETTER_QUEUE, { connection });

  const mailer = new SmtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, password: env.SMTP_PASSWORD, secure: env.SMTP_SECURE === 'true' ? true : undefined, production: env.NODE_ENV === 'production', from: env.MAIL_FROM });
  const emailWorker = new Worker<JobData>('email', createEmailProcessor({ db, mailer, appUrl: env.APP_URL }), {
    connection,
    concurrency: 5,
  });
  emailWorker.on('failed', (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      log(`job ${job.id} exhausted retries -> dead-letter: ${err.message}`);
      void deadLetter.add('email.failed', { queue: 'email', data: job.data, error: err.message }, { jobId: `dlq:${job.id}` });
    }
  });

  const publisher = new RedisPublisher(connection);
  const deps = { db, mailer, publisher, appUrl: env.APP_URL, log };
  const notificationWorker = new Worker<JobData>('notifications', createNotificationProcessor(deps), { connection, concurrency: 5 });
  notificationWorker.on('failed', (job, err) => {
    log(`notification job ${job?.id} attempt ${job?.attemptsMade} failed: ${err.message}`);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void deadLetter.add('notifications.failed', { queue: 'notifications', data: job.data, error: err.message }, { jobId: `dlq:${job.id}` });
    }
  });
  const ai = createProvider(env);
  if (ai.name === 'local') log('AI provider: local (offline, lexical embeddings — development only; set AI_PROVIDER=openai for real models)');
  const knowledgeWorker = new Worker<JobData>('knowledge', createKnowledgeProcessor({ db, ai, log }), { connection, concurrency: 2 });
  knowledgeWorker.on('failed', (job, err) => {
    log(`knowledge job ${job?.id} attempt ${job?.attemptsMade} failed: ${err.message}`);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void deadLetter.add('knowledge.failed', { queue: 'knowledge', data: job.data, error: err.message }, { jobId: `dlq:${job.id}` });
    }
  });
  const meetingProcessor = createMeetingProcessor({ db, ai, storageDir: env.STORAGE_DIR, log });
  const meetingWorker = new Worker<JobData>('meetings', meetingProcessor, { connection, concurrency: 1 });
  meetingWorker.on('failed', (job, err) => {
    log(`meeting job ${job?.id} attempt ${job?.attemptsMade} failed: ${err.message}`);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void meetingProcessor.markExhausted(job, err.message).catch((e) => log(`could not mark meeting failed: ${(e as Error).message}`));
      void deadLetter.add('meetings.failed', { queue: 'meetings', data: job.data, error: err.message }, { jobId: `dlq:${job.id}` });
    }
  });
  // Integrations need an encryption key and OAuth client credentials; without them nothing can be connected.
  let integrationDeps: IntegrationDeps | undefined;
  let googleDeps: GoogleDeps | undefined;
  const key = env.INTEGRATION_ENCRYPTION_KEY ? parseEncryptionKey(env.INTEGRATION_ENCRYPTION_KEY) : undefined;
  if (key && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    integrationDeps = {
      db, log, key,
      github: new GitHubClient({ apiUrl: env.GITHUB_API_URL, oauthUrl: env.GITHUB_OAUTH_URL, clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }),
    };
  } else {
    log('github integration disabled (set INTEGRATION_ENCRYPTION_KEY, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable)');
  }
  if (key && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    googleDeps = {
      db, log, key, ai,
      google: new GoogleClient({
        clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, authUrl: env.GOOGLE_AUTH_URL, tokenUrl: env.GOOGLE_TOKEN_URL,
        revokeUrl: env.GOOGLE_REVOKE_URL, calendarUrl: env.GOOGLE_CALENDAR_API_URL, gmailUrl: env.GMAIL_API_URL,
      }),
    };
  } else {
    log('google integrations disabled (set INTEGRATION_ENCRYPTION_KEY, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable)');
  }
  let integrationWorkerRef: Worker<JobData> | undefined;
  if (integrationDeps || googleDeps) {
    const integrationProcessor = createIntegrationProcessor(integrationDeps, googleDeps);
    const integrationWorker = new Worker<JobData>('integrations', integrationProcessor, { connection, concurrency: 2 });
    integrationWorkerRef = integrationWorker;
    integrationWorker.on('failed', (job, err) => {
      log(`integration job ${job?.id} attempt ${job?.attemptsMade} failed: ${err.message}`);
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void integrationProcessor.markExhausted(job, err.message).catch((e) => log(`could not mark integration job failed: ${(e as Error).message}`));
        void deadLetter.add('integrations.failed', { queue: 'integrations', data: job.data, error: err.message }, { jobId: `dlq:${job.id}` });
      }
    });
  }
  const maintenanceWorker = new Worker(MAINTENANCE_QUEUE, createMaintenanceProcessor(deps, integrationDeps, googleDeps), { connection, concurrency: 1 });
  maintenanceWorker.on('failed', (job, err) => log(`maintenance job ${job?.name} failed: ${err.message}`));
  maintenanceWorker.on('completed', (job, result) => log(`maintenance ${job.name}: ${JSON.stringify(result)}`));
  // idempotent: upserting a scheduler with the same id just updates it, so restarts never duplicate schedules
  await queues.maintenance.upsertJobScheduler('due-reminders', { every: 15 * 60_000 }, { name: 'due-reminders' });
  await queues.maintenance.upsertJobScheduler('expire-agent-actions', { every: 10 * 60_000 }, { name: 'expire-agent-actions' });
  await queues.maintenance.upsertJobScheduler('google-sync', { every: 15 * 60_000 }, { name: 'google-sync' });
  await queues.maintenance.upsertJobScheduler('integration-sync', { every: 15 * 60_000 }, { name: 'integration-sync' });
  await queues.maintenance.upsertJobScheduler('cleanup', { pattern: '0 3 * * *' }, { name: 'cleanup' });

  // metrics + health listener (private network only)
  const obs = createWorkerObservability({
    db,
    queues: { email: queues.email, notifications: queues.notifications, knowledge: queues.knowledge, meetings: queues.meetings, integrations: queues.integrations, maintenance: queues.maintenance, 'dead-letter': queues.deadLetter },
    redisPing: async () => (await connection.ping()) === 'PONG',
    metricsToken: env.METRICS_TOKEN ?? null,
  });
  const allWorkers: Record<string, Pick<Worker, 'on'>> = { email: emailWorker, notifications: notificationWorker, knowledge: knowledgeWorker, meetings: meetingWorker, maintenance: maintenanceWorker };
  if (integrationWorkerRef) allWorkers.integrations = integrationWorkerRef;
  for (const [name, w] of Object.entries(allWorkers)) {
    w.on('completed', () => obs.jobFinished(name, 'completed'));
    w.on('failed', () => obs.jobFinished(name, 'failed'));
  }
  if (env.WORKER_HTTP_PORT > 0) {
    await obs.listen(env.WORKER_HTTP_PORT);
    log(`health/metrics listening on :${env.WORKER_HTTP_PORT}${env.METRICS_TOKEN ? '' : ' (metrics disabled: METRICS_TOKEN not set)'}`);
  }

  const ac = new AbortController();
  const relay = runRelayLoop(db, queues, { signal: ac.signal, log, publisher });

  const shutdown = async () => {
    log('shutting down');
    ac.abort();
    await relay;
    await obs.close();
    await Promise.all([emailWorker.close(), notificationWorker.close(), knowledgeWorker.close(), meetingWorker.close(), maintenanceWorker.close(), integrationWorkerRef?.close()]);
    await Promise.all([queues.email.close(), queues.notifications.close(), queues.knowledge.close(), queues.meetings.close(), queues.integrations.close(), queues.maintenance.close(), queues.deadLetter.close(), deadLetter.close()]);
    await connection.quit();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  log('started (outbox relay, email + notification workers, scheduled jobs)');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
