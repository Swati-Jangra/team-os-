import type { Env } from '@teamos/config';
import { parseEncryptionKey } from '@teamos/integrations';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  authSecret: string;
  appUrl: string;
  apiUrl: string;
  port: number;
  sessionTtlHours: number;
  /** `Secure` cookie attribute; on in production. */
  cookieSecure: boolean;
  lockoutThreshold: number;
  lockoutMinutes: number;
  invitationTtlDays: number;
  emailTokenTtlMinutes: number;
  passwordResetTtlMinutes: number;
  /** Global per-IP request budget; auth routes use stricter per-route limits. */
  globalRateLimitPerMinute: number;
  /** Scales every per-route limit (login, register, ...). Test stacks only: production refuses anything but 1. */
  rateLimitMultiplier: number;
  redisUrl: string;
  /** SSE: heartbeat + session re-validation interval. */
  sseHeartbeatMs: number;
  /** SSE: how long a workspace-visibility decision is cached per connection. */
  sseAccessCacheMs: number;
  /** SSE: max simultaneous streams per user per API process. */
  sseMaxStreamsPerUser: number;
  /** Directory for uploaded meeting audio (shared with the worker). */
  storageDir: string;
  maxAudioBytes: number;
  /** Decoded INTEGRATION_ENCRYPTION_KEY, or null when integrations are not configured. */
  integrationKey: Buffer | null;
  /** Bearer token for GET /metrics; null = /metrics is not served. */
  metricsToken: string | null;
  /** One structured access-log line per request. */
  accessLog: 'json' | 'text' | 'off';
}

export function toAppConfig(env: Env): AppConfig {
  return {
    env: env.NODE_ENV,
    authSecret: env.AUTH_SECRET,
    appUrl: env.APP_URL,
    apiUrl: env.API_URL,
    port: env.API_PORT,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    cookieSecure: env.NODE_ENV === 'production',
    lockoutThreshold: 10,
    lockoutMinutes: 15,
    invitationTtlDays: 7,
    emailTokenTtlMinutes: 60 * 24,
    passwordResetTtlMinutes: 60,
    globalRateLimitPerMinute: env.GLOBAL_RATE_LIMIT_PER_MINUTE,
    rateLimitMultiplier: env.RATE_LIMIT_MULTIPLIER,
    redisUrl: env.REDIS_URL,
    sseHeartbeatMs: 20_000,
    sseAccessCacheMs: 10_000,
    sseMaxStreamsPerUser: 8,
    storageDir: env.STORAGE_DIR,
    maxAudioBytes: 25 * 1024 * 1024, // the speech-to-text API's own upload limit
    integrationKey: env.INTEGRATION_ENCRYPTION_KEY ? parseEncryptionKey(env.INTEGRATION_ENCRYPTION_KEY) : null, // throws at boot if malformed
    metricsToken: env.METRICS_TOKEN ?? null,
    accessLog: env.NODE_ENV === 'test' ? 'off' : (env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'text')),
  };
}
