import { describe, expect, it } from 'vitest';
import { smtpTransportOptions } from './mailer';

describe('smtpTransportOptions', () => {
  it('keeps the local dev sink plaintext', () => {
    expect(smtpTransportOptions({ host: 'localhost', port: 1025 })).toMatchObject({ ignoreTLS: true, requireTLS: false, secure: false });
  });
  it('requires STARTTLS on submission ports', () => {
    expect(smtpTransportOptions({ host: 'smtp.x.io', port: 587, production: true })).toMatchObject({ ignoreTLS: false, requireTLS: true, secure: false });
  });
  it('uses implicit TLS on 465 and does not also demand STARTTLS', () => {
    expect(smtpTransportOptions({ host: 'smtp.x.io', port: 465 })).toMatchObject({ secure: true, requireTLS: false });
  });
  it('never treats port 1025 as a plaintext sink in production', () => {
    expect(smtpTransportOptions({ host: 'relay', port: 1025, production: true })).toMatchObject({ ignoreTLS: false, requireTLS: true });
  });
  it('sends credentials only when configured', () => {
    expect(smtpTransportOptions({ host: 'h', port: 587 })).not.toHaveProperty('auth');
    expect(smtpTransportOptions({ host: 'h', port: 587, user: 'u', password: 'p' })).toMatchObject({ auth: { user: 'u', pass: 'p' } });
  });
});
