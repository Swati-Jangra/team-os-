import type IORedis from 'ioredis';

/** Fire-and-forget live-update transport (Redis pub/sub in production). Delivery is best effort by design:
 *  clients also refetch on reconnect, so a lost hint only delays a refresh. */
export interface Publisher {
  publish(channel: string, message: unknown): Promise<void>;
}

export class RedisPublisher implements Publisher {
  constructor(private readonly redis: IORedis) {}
  async publish(channel: string, message: unknown): Promise<void> {
    await this.redis.publish(channel, JSON.stringify(message));
  }
}

export class MemoryPublisher implements Publisher {
  readonly sent: Array<{ channel: string; message: unknown }> = [];
  async publish(channel: string, message: unknown): Promise<void> {
    this.sent.push({ channel, message });
  }
}
