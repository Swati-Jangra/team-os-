import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encrypted storage for third-party credentials: AES-256-GCM with a random 96-bit IV per value.
 * Format: `v1:<iv>:<tag>:<ciphertext>` (base64url). The key comes from the environment, never the database.
 * `aad` (e.g. the integration id) binds a ciphertext to the row it belongs to, so a value copied to another row fails to decrypt.
 */
export function parseEncryptionKey(b64: string | undefined): Buffer {
  if (!b64) throw new Error('INTEGRATION_ENCRYPTION_KEY is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export const generateWebhookSecret = () => randomBytes(32).toString('hex');

/** GitHub: `X-Hub-Signature-256: sha256=<hex hmac of the raw body>`. Constant-time comparison. */
export function verifyGitHubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
export const signGitHubBody = (secret: string, rawBody: Buffer | string) => `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
