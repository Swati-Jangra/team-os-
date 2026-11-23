import Redis from 'ioredis';

export interface RateLimitResult {
  count: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  /** Records one hit for `key` in a fixed window and returns the running count. */
  hit(key: string, windowSec: number): Promise<RateLimitResult>;
  /** Readiness probe for the backing store. */
  ping?(): Promise<boolean>;
  reset?(): Promise<void>;
  close?(): Promise<void>;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowSec: number): Promise<RateLimitResult> {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowSec * 1000 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (this.buckets.size > 10_000) this.sweep(now);
    return { count: b.count, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }

  async reset(): Promise<void> {
    this.buckets.clear();
  }

  private sweep(now: number): void {
    for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
  }
}

/** Shared across API instances. INCR + EXPIRE-on-first-hit in a single round trip. */
export class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  }

  async hit(key: string, windowSec: number): Promise<RateLimitResult> {
    const k = `rl:${key}`;
    const res = (await this.redis
      .multi()
      .incr(k)
      .expire(k, windowSec, 'NX')
      .ttl(k)
      .exec()) as Array<[Error | null, number]> | null;
    const count = res?.[0]?.[1] ?? 1;
    const ttl = res?.[2]?.[1] ?? windowSec;
    return { count, retryAfterSec: Math.max(1, ttl) };
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
