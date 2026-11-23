import { describe, expect, it } from 'vitest';
import {
  createInvitationSchema,
  createOrganizationSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
  slugSchema,
  updateOrganizationSchema,
} from './index';

describe('auth schemas', () => {
  it('normalizes email on register', () => {
    const r = registerSchema.parse({ email: '  Jane@Example.COM ', name: ' Jane ', password: 'correct-horse-1' });
    expect(r.email).toBe('jane@example.com');
    expect(r.name).toBe('Jane');
  });

  it('rejects weak passwords', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
    expect(passwordSchema.safeParse('onlylettersonly').success).toBe(false);
    expect(passwordSchema.safeParse('1234567890123').success).toBe(false);
    expect(passwordSchema.safeParse('a-good-passw0rd').success).toBe(true);
  });

  it('login does not enforce password policy (avoid leaking rules) but bounds length', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(200) }).success).toBe(false);
  });
});

describe('organization schemas', () => {
  it('slug format', () => {
    expect(slugSchema.safeParse('acme-inc').success).toBe(true);
    expect(slugSchema.safeParse('Acme Inc').success).toBe(false);
    expect(slugSchema.safeParse('-acme').success).toBe(false);
  });

  it('update requires at least one field', () => {
    expect(updateOrganizationSchema.safeParse({}).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ name: 'New' }).success).toBe(true);
  });

  it('create org strips unknown fields (no client-supplied ids)', () => {
    const parsed = createOrganizationSchema.parse({ name: 'Acme', id: 'evil', ownerId: 'evil' });
    expect(parsed).toEqual({ name: 'Acme' });
  });

  it('invitation defaults role to DEVELOPER and rejects unknown roles', () => {
    expect(createInvitationSchema.parse({ email: 'x@y.com' }).role).toBe('DEVELOPER');
    expect(createInvitationSchema.safeParse({ email: 'x@y.com', role: 'SUPERUSER' }).success).toBe(false);
  });
});
