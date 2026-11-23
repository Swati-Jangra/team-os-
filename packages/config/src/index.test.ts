import { describe, expect, it } from 'vitest';
import { loadEnv } from './index';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  AUTH_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.API_PORT).toBe(4000);
    expect(env.REDIS_URL).toContain('redis://');
  });

  it('rejects a short AUTH_SECRET without echoing it', () => {
    expect(() => loadEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
    try {
      loadEnv({ ...base, AUTH_SECRET: 'short' });
    } catch (e) {
      expect(String(e)).not.toContain('short"');
    }
  });

  it('treats empty strings (compose-rendered unset variables) as absent', () => {
    const env = loadEnv({ ...base, METRICS_TOKEN: '', SMTP_SECURE: '', GITHUB_CLIENT_ID: '', API_PORT: '' });
    expect(env.METRICS_TOKEN).toBeUndefined();
    expect(env.SMTP_SECURE).toBeUndefined();
    expect(env.API_PORT).toBe(4000);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadEnv({ AUTH_SECRET: base.AUTH_SECRET })).toThrow(/DATABASE_URL/);
  });

  describe('production', () => {
    const good = {
      ...base,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app_user:pw@db:5432/teamos',
      AUTH_SECRET: 'Zk3v9QpL0mXw7TnB2sYh5RcD8fGj1AeU4oIq6WtN',
      APP_URL: 'https://app.acme.io',
      API_URL: 'https://api.acme.io',
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'k',
      SMTP_HOST: 'smtp.acme.io',
    };
    it('accepts a sound configuration', () => {
      expect(loadEnv(good).NODE_ENV).toBe('production');
    });
    it.each([
      ['http APP_URL', { APP_URL: 'http://app.acme.io' }, /APP_URL/],
      ['placeholder secret', { AUTH_SECRET: 'change-me-change-me-change-me-change-me' }, /AUTH_SECRET/],
      ['low-entropy secret', { AUTH_SECRET: 'a'.repeat(40) }, /AUTH_SECRET/],
      ['superuser database role', { DATABASE_URL: 'postgresql://postgres:pw@db:5432/teamos' }, /app_user/],
      ['offline AI', { AI_PROVIDER: 'local' }, /AI_PROVIDER/],
      ['openai without key', { OPENAI_API_KEY: undefined }, /OPENAI_API_KEY/],
      ['weakened rate limits', { RATE_LIMIT_MULTIPLIER: '50' }, /RATE_LIMIT_MULTIPLIER/],
      ['localhost SMTP', { SMTP_HOST: 'localhost' }, /SMTP_HOST/],
    ])('refuses %s', (_n, patch, re) => {
      expect(() => loadEnv({ ...good, ...patch })).toThrow(re);
    });
    it('does not apply these rules outside production', () => {
      expect(() => loadEnv({ ...base, DATABASE_URL: 'postgresql://postgres:pw@localhost/db' })).not.toThrow();
    });
    it('never echoes secrets in the error', () => {
      try { loadEnv({ ...good, AUTH_SECRET: 'change-me-supersecret-value-0123456789abcdef' }); } catch (e) {
        expect(String(e)).not.toContain('supersecret');
      }
    });
  });
});
