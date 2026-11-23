import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '@teamos/shared';
import { APP_CONFIG, RATE_LIMITER } from '../tokens';
import type { AppConfig } from '../app-config';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../decorators';
import type { RateLimiter } from '../rate-limit/rate-limiter';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? 'unknown';

    const global = await this.limiter.hit(`g:${ip}`, 60);
    if (global.count > this.config.globalRateLimitPerMinute) {
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: global.retryAfterSec });
    }

    const opts = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!opts) return true;

    const route = `${req.method}:${req.route?.path ?? req.path}`;
    let key = `r:${route}:${ip}`;
    if (opts.scope === 'ip-email') {
      const email = typeof (req.body as { email?: unknown })?.email === 'string'
        ? String((req.body as { email: string }).email).trim().toLowerCase().slice(0, 254)
        : '';
      key += `:${email}`;
    }
    const r = await this.limiter.hit(key, opts.windowSec);
    if (r.count > opts.limit * this.config.rateLimitMultiplier) throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: r.retryAfterSec });
    return true;
  }
}
