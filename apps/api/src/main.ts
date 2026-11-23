import { loadEnv } from '@teamos/config';
import { createDb } from '@teamos/database';
import { createApp } from './app';
import { toAppConfig } from './common/app-config';
import { createProvider } from '@teamos/ai-core';
import { GitHubClient, GoogleClient } from '@teamos/integrations';
import { RedisRealtimeBus } from './common/realtime/bus';
import { RedisRateLimiter } from './common/rate-limit/rate-limiter';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const config = toAppConfig(env);
  const db = createDb(env.DATABASE_URL);
  const rateLimiter = new RedisRateLimiter(env.REDIS_URL);
  const realtime = new RedisRealtimeBus(env.REDIS_URL);
  const github = env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && config.integrationKey
    ? new GitHubClient({ apiUrl: env.GITHUB_API_URL, oauthUrl: env.GITHUB_OAUTH_URL, clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET })
    : undefined;
  if (!github) console.log('GitHub integration disabled (set INTEGRATION_ENCRYPTION_KEY, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable)');
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && config.integrationKey
    ? new GoogleClient({
        clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, authUrl: env.GOOGLE_AUTH_URL, tokenUrl: env.GOOGLE_TOKEN_URL,
        revokeUrl: env.GOOGLE_REVOKE_URL, calendarUrl: env.GOOGLE_CALENDAR_API_URL, gmailUrl: env.GMAIL_API_URL,
      })
    : undefined;
  if (!google) console.log('Google integrations disabled (set INTEGRATION_ENCRYPTION_KEY, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable)');
  const app = await createApp({ db, config, rateLimiter, realtime, ai: createProvider(env), github, google });
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`API listening on :${config.port} (/api/v1)`);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
