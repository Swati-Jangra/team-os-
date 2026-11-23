import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '@teamos/database';
import { createApp } from '../app';
import type { AppConfig } from '../common/app-config';
import { MemoryRateLimiter } from '../common/rate-limit/rate-limiter';
import { LocalProvider, type AIProvider } from '@teamos/ai-core';
import type { GitHubClient, GoogleClient } from '@teamos/integrations';
import { MemoryRealtimeBus } from '../common/realtime/bus';

export const PASSWORD = 'correct-horse-battery-9';

export interface Harness {
  t: TestDatabase;
  app: NestExpressApplication;
  limiter: MemoryRateLimiter;
  bus: MemoryRealtimeBus;
  /** Start a real HTTP listener (needed for streaming); returns the base URL. */
  listen(): Promise<string>;
  config: AppConfig;
  /** New, cookie-less client. */
  client(): Client;
  /** Register + verify + log in a brand-new user. */
  signup(email: string, name?: string): Promise<Client>;
  /** Latest unconsumed token emitted via the outbox for an email (what the worker would mail). */
  tokenFor(eventType: string, email: string): Promise<string>;
  close(): Promise<void>;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export class Client {
  userId = '';
  /** Raw `Cookie` header value for non-supertest requests (e.g. SSE via fetch). */
  cookie = '';
  csrf = '';
  private readonly agent: ReturnType<typeof request.agent>;

  constructor(server: unknown) {
    this.agent = request.agent(server as never);
  }

  private send(method: Method, path: string, body?: unknown, headers: Record<string, string> = {}) {
    let req = this.agent[method](`/api/v1${path}`);
    if (this.csrf && !('x-csrf-token' in headers)) req = req.set('x-csrf-token', this.csrf);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return body === undefined ? req : req.send(body as object);
  }

  get = (p: string, h?: Record<string, string>) => this.send('get', p, undefined, h);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.send('post', p, b ?? {}, h);
  put = (p: string, b?: unknown, h?: Record<string, string>) => this.send('put', p, b ?? {}, h);
  patch = (p: string, b?: unknown, h?: Record<string, string>) => this.send('patch', p, b ?? {}, h);
  delete = (p: string, h?: Record<string, string>) => this.send('delete', p, undefined, h);

  putRaw = (p: string, body: Buffer, type: string) => this.send('put', p, undefined, { 'content-type': type }).send(body);

  async login(email: string, password = PASSWORD) {
    const res = await this.post('/auth/login', { email, password });
    if (res.status === 200) {
      this.csrf = res.body.data.csrfToken;
      this.userId = res.body.data.user.id;
      this.cookie = ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');
    }
    return res;
  }
}

export async function createHarness(overrides: Partial<AppConfig> = {}, ai: AIProvider = new LocalProvider(), github?: GitHubClient, google?: GoogleClient): Promise<Harness> {
  const t = await createTestDatabase();
  const limiter = new MemoryRateLimiter();
  const bus = new MemoryRealtimeBus();
  const config: AppConfig = {
    env: 'test',
    authSecret: 'test-secret-test-secret-test-secret-123',
    appUrl: 'http://localhost:3000',
    apiUrl: 'http://localhost:4000',
    port: 0,
    sessionTtlHours: 24,
    cookieSecure: false,
    lockoutThreshold: 10,
    lockoutMinutes: 15,
    invitationTtlDays: 7,
    emailTokenTtlMinutes: 60,
    passwordResetTtlMinutes: 60,
    globalRateLimitPerMinute: 100_000,
    rateLimitMultiplier: 1,
    redisUrl: 'redis://unused',
    sseHeartbeatMs: 100,
    sseAccessCacheMs: 0,
    sseMaxStreamsPerUser: 3,
    storageDir: mkdtempSync(path.join(tmpdir(), 'teamos-api-audio-')),
    maxAudioBytes: 1024 * 1024,
    integrationKey: null,
    metricsToken: null,
    accessLog: 'off',
    ...overrides,
  };
  const app = await createApp({ db: t.db, config, rateLimiter: limiter, realtime: bus, ai, github, google }, { logger: false });
  await app.init();
  const server = app.getHttpServer();

  const tokenFor: Harness['tokenFor'] = async (eventType, email) => {
    const rows = await t.admin
      .selectFrom('outboxEvents')
      .select('payload')
      .where('type', '=', eventType)
      .orderBy('createdAt', 'desc')
      .execute();
    const hit = rows.find((r) => (r.payload as { email?: string }).email === email);
    if (!hit) throw new Error(`no ${eventType} event for ${email}`);
    return (hit.payload as { token: string }).token;
  };

  return {
    t,
    app,
    limiter,
    bus,
    config,
    async listen() {
      await app.listen(0, '127.0.0.1');
      const addr = app.getHttpServer().address() as { port: number };
      return `http://127.0.0.1:${addr.port}`;
    },
    client: () => new Client(server),
    async signup(email, name = email.split('@')[0]!) {
      await limiter.reset();
      const c = new Client(server);
      const reg = await c.post('/auth/register', { email, name, password: PASSWORD });
      if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
      const token = await tokenFor('user.email_verification_requested.v1', email);
      const ver = await c.post('/auth/verify-email', { token });
      if (ver.status !== 200) throw new Error(`verify failed: ${ver.status}`);
      const login = await c.login(email);
      if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
      return c;
    },
    tokenFor,
    async close() {
      await app.close();
      await t.destroy();
    },
  };
}
