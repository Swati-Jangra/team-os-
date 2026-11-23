import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, createHarness, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ lockoutThreshold: 3 });
}, 60_000);
afterAll(async () => {
  await h?.close();
});

describe('registration and email verification', () => {
  it('register -> cannot log in until verified -> verify -> login -> me', async () => {
    const c = h.client();
    const reg = await c.post('/auth/register', { email: 'Alice@Example.com', name: 'Alice', password: PASSWORD });
    expect(reg.status).toBe(201);
    expect(reg.body.data).toEqual({ status: 'verification_sent' });
    expect(reg.headers['x-request-id']).toBeTruthy();

    const early = await c.login('alice@example.com');
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const token = await h.tokenFor('user.email_verification_requested.v1', 'alice@example.com');
    expect((await c.post('/auth/verify-email', { token })).status).toBe(200);
    // single use
    const again = await c.post('/auth/verify-email', { token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('TOKEN_INVALID');

    const login = await c.login('ALICE@example.com');
    expect(login.status).toBe(200);
    const setCookie = (login.headers['set-cookie'] as unknown as string[]).join(';');
    expect(setCookie).toMatch(/teamos_session=[^;]+;.*HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe('alice@example.com');
    expect(me.body.data.memberships).toEqual([]);
  });

  it('stores only hashes: no raw session or email token appears in the database', async () => {
    const token = await h.tokenFor('user.email_verification_requested.v1', 'alice@example.com');
    const rows = await h.t.admin.selectFrom('emailTokens').select('tokenHash').execute();
    expect(rows.map((r) => r.tokenHash)).not.toContain(token);
    const users = await h.t.admin.selectFrom('users').select('passwordHash').execute();
    for (const u of users) expect(u.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('registering an existing email gives the same answer (no account enumeration) and creates nothing', async () => {
    await h.limiter.reset();
    const before = Number((await h.t.admin.selectFrom('users').select((e) => e.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
    const res = await h.client().post('/auth/register', { email: 'alice@example.com', name: 'Mallory', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ status: 'verification_sent' });
    const after = Number((await h.t.admin.selectFrom('users').select((e) => e.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
    expect(after).toBe(before);
  });

  it('rejects weak passwords and malformed input with field details', async () => {
    const res = await h.client().post('/auth/register', { email: 'not-an-email', name: '', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const fields = new Set(res.body.error.details.map((d: { path: string }) => d.path));
    expect([...fields].sort()).toEqual(['email', 'name', 'password']);
  });
});

describe('login, sessions, logout, CSRF', () => {
  it('wrong password and unknown email are indistinguishable', async () => {
    await h.limiter.reset();
    const a = await h.client().login('alice@example.com', 'wrong-password-1');
    const b = await h.client().login('nobody@example.com', 'wrong-password-1');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe(b.body.error.code);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('unauthenticated requests are rejected', async () => {
    const res = await h.client().get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('state-changing requests need the CSRF header', async () => {
    const c = await h.signup('csrf@example.com');
    const noHeader = await c.post('/organizations', { name: 'X' }, { 'x-csrf-token': '' });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF_FAILED');
    const wrong = await c.post('/organizations', { name: 'X' }, { 'x-csrf-token': 'nope' });
    expect(wrong.status).toBe(403);
    // GETs don't need it
    expect((await c.get('/auth/me', { 'x-csrf-token': '' })).status).toBe(200);
    expect((await c.post('/organizations', { name: 'CSRF Org' })).status).toBe(201);
  });

  it('logout revokes the session server-side', async () => {
    const c = await h.signup('logout@example.com');
    expect((await c.get('/auth/me')).status).toBe(200);
    expect((await c.post('/auth/logout')).status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('a stolen cookie stops working once revoked from another session', async () => {
    const c1 = await h.signup('multi@example.com');
    const c2 = h.client();
    expect((await c2.login('multi@example.com')).status).toBe(200);
    const list = await c1.get('/auth/sessions');
    expect(list.body.data).toHaveLength(2);
    const other = list.body.data.find((s: { current: boolean }) => !s.current);
    expect((await c1.delete(`/auth/sessions/${other.id}`)).status).toBe(200);
    expect((await c2.get('/auth/me')).status).toBe(401);
    expect((await c1.get('/auth/me')).status).toBe(200);
  });

  it('locks the account after repeated failures, even for the right password, then audits it', async () => {
    await h.signup('lock@example.com');
    await h.limiter.reset();
    for (let i = 0; i < 3; i++) {
      expect((await h.client().login('lock@example.com', 'bad-password-123')).status).toBe(401);
    }
    const locked = await h.client().login('lock@example.com');
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeTruthy();
    const audit = await h.t.admin.selectFrom('auditLogs').select('action').where('action', '=', 'auth.account_locked').execute();
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('rate limits login attempts per ip+email', async () => {
    await h.limiter.reset();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await h.client().login('ratelimit@example.com', 'bad-password-123')).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('password reset', () => {
  it('forgot-password answers identically for unknown emails and sends nothing', async () => {
    await h.limiter.reset();
    const known = await h.client().post('/auth/forgot-password', { email: 'alice@example.com' });
    const unknown = await h.client().post('/auth/forgot-password', { email: 'ghost@example.com' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    await expect(h.tokenFor('user.password_reset_requested.v1', 'ghost@example.com')).rejects.toThrow();
  });

  it('reset sets the new password, is single-use, and signs out all sessions', async () => {
    const c = await h.signup('reset@example.com');
    await h.limiter.reset();
    await h.client().post('/auth/forgot-password', { email: 'reset@example.com' });
    const token = await h.tokenFor('user.password_reset_requested.v1', 'reset@example.com');

    const weak = await h.client().post('/auth/reset-password', { token, password: 'weak' });
    expect(weak.status).toBe(400);

    const ok = await h.client().post('/auth/reset-password', { token, password: 'brand-new-passw0rd' });
    expect(ok.status).toBe(200);
    expect((await h.client().post('/auth/reset-password', { token, password: 'another-passw0rd-2' })).status).toBe(400);

    expect((await c.get('/auth/me')).status).toBe(401); // old session killed
    expect((await h.client().login('reset@example.com', PASSWORD)).status).toBe(401);
    expect((await h.client().login('reset@example.com', 'brand-new-passw0rd')).status).toBe(200);
  });
});

describe('transactional outbox', () => {
  it('registration enqueued versioned events in the same transaction as the user', async () => {
    const ev = await h.t.admin
      .selectFrom('outboxEvents')
      .select(['type', 'version', 'publishedAt'])
      .where('type', 'in', ['user.registered.v1', 'user.email_verification_requested.v1'])
      .execute();
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(ev.every((e) => e.version === 1 && e.publishedAt === null)).toBe(true);
  });
});
