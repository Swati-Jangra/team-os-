import Redis from 'ioredis';

/** Receives live-update messages published by the worker. The API only ever *subscribes*. */
export interface RealtimeBus {
  /** Subscribe to channels; returns an unsubscribe function. */
  subscribe(channels: string[], onMessage: (channel: string, raw: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** In-process bus (tests, single-node dev). `publish` is exposed for tests. */
export class MemoryRealtimeBus implements RealtimeBus {
  private readonly subs = new Set<{ channels: Set<string>; fn: (c: string, raw: string) => void }>();

  async subscribe(channels: string[], fn: (c: string, raw: string) => void) {
    const sub = { channels: new Set(channels), fn };
    this.subs.add(sub);
    return async () => void this.subs.delete(sub);
  }
  publish(channel: string, message: unknown): void {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    for (const s of this.subs) if (s.channels.has(channel)) s.fn(channel, raw);
  }
  get subscriberCount(): number {
    return this.subs.size;
  }
  async close(): Promise<void> {
    this.subs.clear();
  }
}

/** One shared Redis subscriber connection, with per-channel reference counting. */
export class RedisRealtimeBus implements RealtimeBus {
  private readonly redis: Redis;
  private readonly handlers = new Map<string, Set<(c: string, raw: string) => void>>();

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: null });
    this.redis.on('error', (e) => console.error(`[realtime] redis error: ${e.message}`));
    this.redis.on('message', (channel: string, raw: string) => {
      for (const fn of this.handlers.get(channel) ?? []) fn(channel, raw);
    });
  }

  async subscribe(channels: string[], fn: (c: string, raw: string) => void) {
    for (const ch of channels) {
      let set = this.handlers.get(ch);
      if (!set) {
        set = new Set();
        this.handlers.set(ch, set);
        await this.redis.subscribe(ch);
      }
      set.add(fn);
    }
    return async () => {
      for (const ch of channels) {
        const set = this.handlers.get(ch);
        if (!set) continue;
        set.delete(fn);
        if (set.size === 0) {
          this.handlers.delete(ch);
          await this.redis.unsubscribe(ch).catch(() => undefined);
        }
      }
    };
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
