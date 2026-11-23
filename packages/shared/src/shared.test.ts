import { describe, expect, it } from 'vitest';
import {
  AppError,
  buildPageMeta,
  canonicalJson,
  normalizeEmail,
  normalizePage,
  randomToken,
  safeEqual,
  sha256Hex,
  slugify,
  toSkipTake,
} from './index';

describe('crypto helpers', () => {
  it('randomToken is unique and url-safe', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it('sha256Hex is deterministic', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('safeEqual handles length mismatch', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
  });

  it('canonicalJson ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }),
    );
  });
});

describe('text helpers', () => {
  it('slugify', () => {
    expect(slugify('  Acme Inc. — Café!! ')).toBe('acme-inc-cafe');
  });
  it('normalizeEmail', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});

describe('pagination', () => {
  it('clamps values', () => {
    expect(normalizePage({ page: -5, pageSize: 9999 })).toEqual({ page: 1, pageSize: 100 });
    expect(normalizePage({})).toEqual({ page: 1, pageSize: 20 });
  });
  it('skip/take and meta', () => {
    expect(toSkipTake({ page: 3, pageSize: 20 })).toEqual({ skip: 40, take: 20 });
    expect(buildPageMeta({ page: 1, pageSize: 20 }, 45).totalPages).toBe(3);
    expect(buildPageMeta({ page: 1, pageSize: 20 }, 0).totalPages).toBe(1);
  });
});

describe('AppError', () => {
  it('maps code to status', () => {
    const e = new AppError('FORBIDDEN');
    expect(e.status).toBe(403);
    expect(e.code).toBe('FORBIDDEN');
  });
});
