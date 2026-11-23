import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { GitHubClient, GitHubError, decryptSecret, encryptSecret, extractTaskKeys, normalizeCommit, normalizePull, parseEncryptionKey, signGitHubBody, verifyGitHubSignature } from './index';

const key = randomBytes(32);

describe('vault', () => {
  it('round-trips, is randomised, and binds a secret to its row', () => {
    const a = encryptSecret('gho_secret', key, 'row-1');
    expect(a).not.toContain('gho_secret');
    expect(encryptSecret('gho_secret', key, 'row-1')).not.toBe(a);
    expect(decryptSecret(a, key, 'row-1')).toBe('gho_secret');
    expect(() => decryptSecret(a, key, 'row-2')).toThrow(); // copied to another row
    expect(() => decryptSecret(a, randomBytes(32), 'row-1')).toThrow(); // wrong key
    expect(() => decryptSecret(a.slice(0, -2) + 'AA', key, 'row-1')).toThrow(); // tampered
  });
  it('validates the key', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
    expect(() => parseEncryptionKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
    expect(parseEncryptionKey(key.toString('base64'))).toHaveLength(32);
  });
});

describe('webhook signatures', () => {
  const body = Buffer.from('{"action":"opened"}');
  it('accepts only the correct HMAC of the exact raw body', () => {
    const sig = signGitHubBody('s3cret', body);
    expect(verifyGitHubSignature('s3cret', body, sig)).toBe(true);
    expect(verifyGitHubSignature('other', body, sig)).toBe(false);
    expect(verifyGitHubSignature('s3cret', Buffer.from('{"action":"closed"}'), sig)).toBe(false);
    for (const bad of [undefined, '', 'sha256=', 'sha1=abc', 'sha256=zz', sig.slice(0, -2)]) expect(verifyGitHubSignature('s3cret', body, bad)).toBe(false);
  });
});

describe('task key extraction', () => {
  it('finds identifiers in titles and branch names, case-insensitively and uniquely', () => {
    expect(extractTaskKeys('Fix login (APO-12)', 'feature/apo-12-login-fix', 'also BET-3, apo-12')).toEqual([{ key: 'APO', number: 12 }, { key: 'BET', number: 3 }]);
    expect(extractTaskKeys('utf-8 and sha-256 mention', 'x1-2y', null)).toEqual([{ key: 'UTF', number: 8 }, { key: 'SHA', number: 256 }]); // plausible keys; the lookup decides
    expect(extractTaskKeys('release v1.2-3a', undefined)).toEqual([]);
  });
});

describe('normalizers', () => {
  it('maps pull requests and commits and does not keep bodies', () => {
    const pr = normalizePull({ number: 7, title: 'APO-1 fix', state: 'closed', merged_at: '2026-01-01T00:00:00Z', html_url: 'https://x/7', user: { login: 'bob' }, head: { ref: 'f/apo-1' }, body: 'secret text' });
    expect(pr).toMatchObject({ kind: 'PULL_REQUEST', externalId: '7', state: 'merged', authorLogin: 'bob', headRef: 'f/apo-1' });
    expect(JSON.stringify(pr)).not.toContain('secret text');
    expect(normalizeCommit({ sha: 'abc', commit: { message: 'first line\nbody', author: { name: 'n', date: '2026-01-01T00:00:00Z' } }, html_url: 'u' })).toMatchObject({ externalId: 'abc', title: 'first line' });
  });
});

describe('GitHubClient', () => {
  const mk = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) =>
    new GitHubClient({ apiUrl: 'https://api.test', oauthUrl: 'https://gh.test', clientId: 'cid', clientSecret: 'csec', fetch: (async (u: string, i: RequestInit) => handler(String(u), i)) as never });
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });

  it('builds the authorize URL and exchanges codes', async () => {
    const c = mk((url, init) => {
      expect(url).toBe('https://gh.test/login/oauth/access_token');
      expect(JSON.parse(String(init.body))).toMatchObject({ client_id: 'cid', client_secret: 'csec', code: 'c1' });
      return json({ access_token: 'tok', scope: 'repo' });
    });
    const u = new URL(c.authorizeUrl('st', 'https://app/cb', ['repo', 'admin:repo_hook']));
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('scope')).toBe('repo admin:repo_hook');
    expect(await c.exchangeCode('c1', 'https://app/cb')).toEqual({ accessToken: 'tok', scope: 'repo' });
    await expect(mk(() => json({ error: 'bad_verification_code' })).exchangeCode('x', 'y')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('classifies errors for retry decisions', async () => {
    const code = async (res: () => Response) => mk(res).getViewer('t').catch((e: GitHubError) => ({ code: e.code, retryable: e.retryable }));
    expect(await code(() => json({}, 401))).toEqual({ code: 'UNAUTHORIZED', retryable: false });
    expect(await code(() => json({}, 403, { 'x-ratelimit-remaining': '0' }))).toEqual({ code: 'RATE_LIMITED', retryable: true });
    expect(await code(() => json({}, 403))).toEqual({ code: 'FORBIDDEN', retryable: false });
    expect(await code(() => json({}, 404))).toEqual({ code: 'NOT_FOUND', retryable: false });
    expect(await code(() => json({}, 502))).toEqual({ code: 'SERVER', retryable: true });
    const down = new GitHubClient({ apiUrl: 'x', oauthUrl: 'y', clientId: '', clientSecret: '', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as never });
    await expect(down.getViewer('t')).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
  });

  it('pages newest-first, stops at `since`, filters PRs out of issues, and validates repo names', async () => {
    const pulls = [{ number: 3, title: 'c', state: 'open', updated_at: '2026-03-01T00:00:00Z' }, { number: 2, title: 'b', state: 'open', updated_at: '2026-02-01T00:00:00Z' }, { number: 1, title: 'a', state: 'open', updated_at: '2026-01-01T00:00:00Z' }];
    const c = mk((url) => (url.includes('/pulls') ? json(pulls) : json([{ number: 5, title: 'i', state: 'open' }, { number: 6, title: 'pr as issue', pull_request: {} }])));
    expect((await c.listPulls('t', 'o/r', '2026-01-15T00:00:00Z')).map((p) => p.externalId)).toEqual(['3', '2']);
    expect((await c.listIssues('t', 'o/r', null)).map((p) => p.externalId)).toEqual(['5']);
    await expect(c.listPulls('t', '../../etc/passwd', null)).rejects.toThrow(/Invalid repository/);
    await expect(c.listPulls('t', 'o/r?x=1', null)).rejects.toThrow(/Invalid repository/);
  });

  it('creates and deletes webhooks with the documented payload', async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const c = mk((url, init) => { seen.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined }); return init.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ id: 99 }, 201); });
    expect(await c.createWebhook('t', 'o/r', 'https://app/hook', 'sec')).toEqual({ id: 99 });
    await c.deleteWebhook('t', 'o/r', 99);
    expect(seen[0]!.body).toMatchObject({ events: ['pull_request', 'issues', 'push'], config: { url: 'https://app/hook', secret: 'sec', content_type: 'json' } });
    expect(seen[1]).toMatchObject({ url: 'https://api.test/repos/o/r/hooks/99', method: 'DELETE' });
  });
});
