import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, PERMISSION_KEY, RATE_LIMIT_KEY } from '../common/decorators';
import { createHarness, type Harness } from './harness';

const TOKEN = 'metrics-token-metrics-token-1234';
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ metricsToken: TOKEN });
}, 60_000);
afterAll(async () => {
  await h?.close();
});

interface RouteInfo {
  method: string;
  path: string;
  isPublic: boolean;
  permission?: string;
  rateLimited: boolean;
}

function inventory(): RouteInfo[] {
  const reflector = new Reflector();
  const out: RouteInfo[] = [];
  for (const mod of h.app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctor = wrapper.metatype as (new (...a: never[]) => object) | null;
      if (!ctor) continue;
      const base = (Reflect.getMetadata(PATH_METADATA, ctor) as string | undefined) ?? '';
      const proto = ctor.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = proto[name];
        if (typeof fn !== 'function' || name === 'constructor') continue;
        const verb = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
        if (verb === undefined) continue;
        const sub = (Reflect.getMetadata(PATH_METADATA, fn) as string | undefined) ?? '';
        const get = <T>(k: string) => reflector.getAllAndOverride<T | undefined>(k, [fn as never, ctor]);
        out.push({
          method: RequestMethod[verb]!,
          path: `/${[base, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1'),
          isPublic: get<boolean>(IS_PUBLIC) === true,
          permission: get<string>(PERMISSION_KEY),
          rateLimited: get(RATE_LIMIT_KEY) !== undefined,
        });
      }
    }
  }
  return out;
}

describe('route authorization inventory (fails when a new route is added without a conscious decision)', () => {
  const routes = () => inventory();

  it('discovers the API surface', () => {
    expect(routes().length).toBeGreaterThan(120);
  });

  it('the set of public (unauthenticated) routes is exactly this list', () => {
    const pub = routes().filter((r) => r.isPublic).map((r) => `${r.method} ${r.path}`).sort();
    expect(pub).toEqual(
      [
        'GET /health',
        'GET /health/live',
        'GET /health/ready',
        'POST /auth/register',
        'POST /auth/login',
        'POST /auth/verify-email',
        'POST /auth/forgot-password',
        'POST /auth/reset-password',
        'POST /webhooks/github/:repoId',
      ].sort(),
    );
  });

  it('every public route that accepts input has its own rate limit', () => {
    // the global per-IP budget applies to everything; credential/token endpoints need a stricter one
    const mustLimit = ['POST /auth/register', 'POST /auth/login', 'POST /auth/forgot-password', 'POST /auth/reset-password', 'POST /auth/verify-email'];
    const limited = new Set(routes().filter((r) => r.rateLimited).map((r) => `${r.method} ${r.path}`));
    for (const r of mustLimit) expect(limited.has(r), r).toBe(true);
  });

  it('every authenticated org-scoped route declares a required permission or is explicitly member-level', () => {
    // member-level = any org member may call it; the service itself filters by what the caller can see
    const memberLevel = new Set(routes().filter((r) => !r.isPublic && r.path.includes(':orgId') && !r.permission).map((r) => `${r.method} ${r.path}`));
    // This list is reviewed by hand: every entry must apply its own check (ownership / visibility) in the service.
    expect([...memberLevel].sort()).toMatchSnapshot();
  });

  it('routes outside an organization are either public or user-scoped (never silently open)', () => {
    const odd = routes().filter((r) => !r.isPublic && !r.path.includes(':orgId')).map((r) => `${r.method} ${r.path}`).sort();
    expect(odd).toMatchSnapshot();
  });
});

describe('transport headers and error hygiene', () => {
  it('sets security headers and hides the framework', async () => {
    const r = await h.client().get('/health');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeTruthy();
    expect(r.headers['strict-transport-security']).toBeTruthy();
  });

  it('CORS only admits the configured origin', async () => {
    const bad = await h.client().get('/health', { origin: 'https://evil.example' });
    // the cors middleware answers with the single allowed origin; a browser then refuses the mismatch
    expect(bad.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(bad.headers['access-control-allow-origin']).not.toBe('*');
    const ok = await h.client().get('/health', { origin: h.config.appUrl });
    expect(ok.headers['access-control-allow-origin']).toBe(h.config.appUrl);
  });

  it('mutations without a CSRF token are refused even with a valid session', async () => {
    const c = await h.signup('csrf@example.com');
    const r = await c.post('/organizations', { name: 'X' }, { 'x-csrf-token': 'wrong' });
    expect(r.status).toBe(403);
  });

  it('unknown routes and oversized bodies use the error envelope and leak nothing', async () => {
    const nf = await h.client().get('/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.requestId).toBeTruthy();
    const big = await h.client().post('/auth/login', { email: 'a@b.co', password: 'x'.repeat(2 * 1024 * 1024) });
    expect(big.status).toBe(413);
    expect(JSON.stringify(big.body)).not.toMatch(/stack|node_modules|at \w+ \(/);
  });

  it('echoes only well-formed request ids', async () => {
    const good = await h.client().get('/health', { 'x-request-id': 'abc12345-req' });
    expect(good.headers['x-request-id']).toBe('abc12345-req');
    const bad = await h.client().get('/health', { 'x-request-id': 'x\r\ninjected: 1' }).catch(() => null);
    if (bad) expect(bad.headers['x-request-id']).not.toContain('injected');
  });
});

describe('health and metrics', () => {
  it('live is dependency-free and ready checks Postgres and Redis', async () => {
    expect((await h.client().get('/health/live')).body.data).toEqual({ status: 'live' });
    const ready = await h.client().get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data).toEqual({ status: 'ready', checks: { database: true, redis: true } });
  });

  it('ready reports 503 when Redis is unreachable', async () => {
    const orig = h.limiter.ping;
    h.limiter.ping = async () => false;
    try {
      const r = await h.client().get('/health/ready');
      expect(r.status).toBe(503);
      expect(r.body.data.checks.redis).toBe(false);
    } finally {
      h.limiter.ping = orig;
    }
  });

  it('/metrics needs the bearer token and exposes route templates, not ids', async () => {
    const srv = h.app.getHttpServer();
    const { default: request } = await import('supertest');
    expect((await request(srv).get('/metrics')).status).toBe(401);
    expect((await request(srv).get('/metrics').set('authorization', 'Bearer wrong-wrong-wrong-wrong-1234')).status).toBe(401);
    const c = await h.signup('metrics@example.com');
    const org = (await c.post('/organizations', { name: 'Metrics Org' })).body.data;
    await c.get(`/organizations/${org.id}/workspaces`);
    const ok = await request(srv).get('/metrics').set('authorization', `Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('teamos_http_requests_total');
    expect(ok.text).toContain('teamos_http_request_duration_seconds_bucket');
    expect(ok.text).toContain('route="/api/v1/organizations/:orgId/workspaces"');
    expect(ok.text).not.toContain(org.id);
    expect(ok.text).not.toContain('metrics@example.com');
  });

  it('/metrics is not served (404) when no token is configured', async () => {
    const h2 = await createHarness({ metricsToken: null });
    try {
      const { default: request } = await import('supertest');
      expect((await request(h2.app.getHttpServer()).get('/metrics')).status).toBe(404);
    } finally {
      await h2.close();
    }
  });
});

describe('generated route reference', () => {
  const file = path.resolve(__dirname, '../../../../docs/ROUTES.md');
  const render = () => {
    const rows = inventory()
      .map((r) => ({ ...r, path: `/api/v1${r.path}` }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    const access = (r: RouteInfo) => (r.isPublic ? 'public' : r.permission ? `\`${r.permission}\`` : r.path.includes(':orgId') ? 'org member (own data)' : 'signed-in user');
    return [
      '# Route reference',
      '',
      '_Generated from the controllers by `apps/api/src/test/hardening.e2e.test.ts`. Do not edit by hand: run `WRITE_ROUTES_DOC=1 pnpm --filter @teamos/api test hardening` after adding or changing a route. The test fails when this file is stale._',
      '',
      'This is a route/permission index, **not** an OpenAPI document: request and response schemas are in `docs/API.md` and `packages/validation`.',
      '',
      '| Method | Path | Access | Own rate limit |',
      '|---|---|---|---|',
      ...rows.map((r) => `| ${r.method} | \`${r.path}\` | ${access(r)} | ${r.rateLimited ? 'yes' : ''} |`),
      '',
    ].join('\n');
  };
  it('docs/ROUTES.md matches the actual routes', () => {
    const text = render();
    if (process.env.WRITE_ROUTES_DOC === '1') writeFileSync(file, text);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
});
