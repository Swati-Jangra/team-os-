import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from '@teamos/database';
import { AppError } from '@teamos/shared';
import { Public } from '../../common/decorators';
import { RATE_LIMITER } from '../../common/tokens';
import type { RateLimiter } from '../../common/rate-limit/rate-limiter';
import { DbService } from '../../db/db.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  /** Back-compat: database check only. */
  @Public()
  @Get()
  async check() {
    try {
      await sql`SELECT 1`.execute(this.dbs.db);
    } catch {
      throw new AppError('INTERNAL', 'Database unavailable');
    }
    return { status: 'ok' };
  }

  /** Liveness: the process answers. Never touches dependencies, so a DB blip does not get the pod restarted. */
  @Public()
  @Get('live')
  live() {
    return { status: 'live' };
  }

  /** Readiness: Postgres and Redis reachable. 503 tells the load balancer to stop routing here. */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const database = await sql`SELECT 1`.execute(this.dbs.db).then(() => true, () => false);
    const redis = this.limiter.ping ? await this.limiter.ping() : true;
    const ok = database && redis;
    if (!ok) res.status(503);
    return { status: ok ? 'ready' : 'unavailable', checks: { database, redis } };
  }
}
