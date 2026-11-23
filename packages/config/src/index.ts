import { z } from 'zod';

/** Validated environment. Fails fast at boot with a readable error; never logs values. */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:4000'),
  API_PORT: z.coerce.number().int().default(4000),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** 'true' = implicit TLS. Default: implicit on port 465, STARTTLS (required in production) otherwise. */
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  MAIL_FROM: z.string().default('TeamOS AI <no-reply@teamos.local>'),
  /** Where meeting audio is stored. Must be the SAME directory for the API and the worker (single host / shared volume). */
  STORAGE_DIR: z.string().default('./storage'),
  /** Per-IP request budget per minute across the whole API (auth routes have stricter limits of their own). */
  GLOBAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(600),
  /** Multiplies every per-route rate limit. For automated test stacks only; production requires 1. */
  RATE_LIMIT_MULTIPLIER: z.coerce.number().int().min(1).max(1000).default(1),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(24 * 7),
  /** 'local' = offline deterministic provider (dev/test only); 'openai' needs OPENAI_API_KEY. */
  AI_PROVIDER: z.enum(['local', 'openai']).default('local'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_CHAT_MODEL: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  /** Bearer token that protects GET /metrics. Without it /metrics is not served. */
  METRICS_TOKEN: z.string().min(24, 'METRICS_TOKEN must be at least 24 characters').optional(),
  /** Port of the worker's health/metrics listener (0 disables it). */
  WORKER_HTTP_PORT: z.coerce.number().int().min(0).default(4100),
  /** Production refuses the offline AI provider unless this is explicitly set. */
  ALLOW_LOCAL_AI: z.enum(['true', 'false']).default('false'),
  /** 'json' (one line per event, for log pipelines) or 'text'. */
  LOG_FORMAT: z.enum(['json', 'text']).optional(),
  /** 32 random bytes, base64. Encrypts third-party tokens and webhook secrets. Integrations are disabled without it. */
  INTEGRATION_ENCRYPTION_KEY: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  /** Overridable so tests and GitHub Enterprise can point elsewhere. */
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_OAUTH_URL: z.string().url().default('https://github.com'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Overridable so tests can point at a local stand-in. */
  GOOGLE_AUTH_URL: z.string().url().default('https://accounts.google.com/o/oauth2/v2/auth'),
  GOOGLE_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),
  GOOGLE_REVOKE_URL: z.string().url().default('https://oauth2.googleapis.com/revoke'),
  GOOGLE_CALENDAR_API_URL: z.string().url().default('https://www.googleapis.com/calendar/v3'),
  GMAIL_API_URL: z.string().url().default('https://gmail.googleapis.com/gmail/v1'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Settings that are fine on a laptop but unsafe in production. Returns human-readable problems
 * (never the offending values).
 */
export function productionProblems(env: Env): string[] {
  const problems: string[] = [];
  if (!env.APP_URL.startsWith('https://')) problems.push('APP_URL must be https:// (session cookies are Secure)');
  if (!env.API_URL.startsWith('https://')) problems.push('API_URL must be https:// (OAuth redirects and webhooks use it)');
  if (/change.?me|example|secret|password|dev/i.test(env.AUTH_SECRET) || new Set(env.AUTH_SECRET).size < 12) {
    problems.push('AUTH_SECRET looks like a placeholder or has too little entropy; generate one with `openssl rand -base64 48`');
  }
  let dbUser = '';
  try { dbUser = decodeURIComponent(new URL(env.DATABASE_URL).username); } catch { /* validated as URL already */ }
  if (['postgres', 'migrator', 'root'].includes(dbUser)) {
    problems.push(`DATABASE_URL connects as "${dbUser}"; the app must connect as the NOBYPASSRLS application role (app_user), or tenant isolation is void`);
  }
  if (env.AI_PROVIDER === 'local' && env.ALLOW_LOCAL_AI !== 'true') {
    problems.push('AI_PROVIDER=local is an offline development stub; set AI_PROVIDER=openai (or ALLOW_LOCAL_AI=true to accept this knowingly)');
  }
  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) problems.push('AI_PROVIDER=openai needs OPENAI_API_KEY');
  if (env.RATE_LIMIT_MULTIPLIER !== 1) problems.push('RATE_LIMIT_MULTIPLIER must be 1 in production (it weakens brute-force protection)');
  if (env.SMTP_HOST === 'localhost') problems.push('SMTP_HOST is localhost; invitations and password resets would never be delivered');
  return problems;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // docker-compose renders unset optional variables as empty strings; treat them as absent
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    const problems = productionProblems(parsed.data);
    if (problems.length) throw new Error(`Unsafe production configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return parsed.data;
}
