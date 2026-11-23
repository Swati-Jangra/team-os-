import { describe, expect, it } from 'vitest';
import { ROLES } from '@teamos/permissions';
import { actionLabel, ROLE_LABEL, ROLE_TONE, timeAgo } from './labels';
import { safeNext } from '../features/auth/auth-shell';

describe('safeNext (open-redirect guard)', () => {
  it('allows same-site relative paths', () => {
    expect(safeNext('/o/123/dashboard')).toBe('/o/123/dashboard');
  });
  it.each(['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', '', null])('rejects %s', (v) => {
    expect(safeNext(v as string | null)).toBe('/');
  });
});

describe('labels', () => {
  it('has a label and tone for every role', () => {
    for (const r of ROLES) {
      expect(ROLE_LABEL[r]).toBeTruthy();
      expect(ROLE_TONE[r]).toBeTruthy();
    }
  });
  it('humanizes known actions and falls back for unknown ones', () => {
    expect(actionLabel('auth.login')).toBe('Signed in');
    expect(actionLabel('something.new_thing')).toBeTruthy();
  });
  it('formats relative time', () => {
    expect(timeAgo(new Date())).toMatch(/just now|now/i);
    expect(timeAgo(new Date(Date.now() - 3 * 3600_000))).toMatch(/3/);
  });
});
