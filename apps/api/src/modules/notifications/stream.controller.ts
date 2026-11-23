import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sql } from '@teamos/database';
import { rtOrgChannel, rtUserChannel, type RealtimeMessage } from '@teamos/event-contracts';
import { AppError } from '@teamos/shared';
import type { RequestActor } from '../../common/actor';
import { APP_CONFIG, REALTIME } from '../../common/tokens';
import type { AppConfig } from '../../common/app-config';
import { CurrentActor } from '../../common/decorators';
import type { RealtimeBus } from '../../common/realtime/bus';
import { DbService } from '../../db/db.service';
import { SESSION_COOKIE, SessionService } from '../auth/session.service';

/**
 * Server-Sent Events stream of live-update HINTS (ids only — see toRealtimeHint). The browser reacts by
 * re-fetching through the normal authorized API, so nothing sensitive ever rides on this channel.
 *
 * Authorization is enforced three ways:
 *  - connection: normal auth + org-membership guards (non-members get 404);
 *  - per event: hints for a workspace are forwarded only if the user can currently see that workspace;
 *  - over time: the session and org membership are re-checked every heartbeat, and the stream is closed when either is gone.
 */
@Controller('organizations/:orgId/stream')
export class StreamController {
  private readonly open = new Map<string, number>();

  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(REALTIME) private readonly bus: RealtimeBus,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async stream(@CurrentActor() actor: RequestActor, @Req() req: Request, @Res() res: Response): Promise<void> {
    const count = this.open.get(actor.userId) ?? 0;
    if (count >= this.config.sseMaxStreamsPerUser) throw new AppError('RATE_LIMITED', 'Too many open live connections');
    this.open.set(actor.userId, count + 1);

    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE] ?? '';
    const orgCh = rtOrgChannel(actor.orgId);
    const userCh = rtUserChannel(actor.userId);
    let closed = false;
    let unsubscribe: (() => Promise<void>) | undefined;
    // eslint-disable-next-line prefer-const -- assigned after the cleanup closure that reads it is defined
    let timer: NodeJS.Timeout | undefined;
    const accessCache = new Map<string, { ok: boolean; at: number }>();

    const close = (reason?: string) => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      void unsubscribe?.().catch(() => undefined);
      this.open.set(actor.userId, Math.max(0, (this.open.get(actor.userId) ?? 1) - 1));
      if (reason && !res.writableEnded) res.write(`event: close\ndata: ${JSON.stringify({ reason })}\n\n`);
      if (!res.writableEnded) res.end();
    };
    const send = (event: string, data: unknown) => {
      if (!closed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    /** Is the user still an org member, and (if given) can they see this workspace? Cached briefly. */
    const canSee = async (workspaceId?: string): Promise<boolean> => {
      const key = workspaceId ?? '*';
      const hit = accessCache.get(key);
      if (hit && Date.now() - hit.at < this.config.sseAccessCacheMs) return hit.ok;
      const r = await this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, (trx) =>
        workspaceId
          ? sql<{ ok: boolean }>`SELECT (app_is_org_member(${actor.orgId}::uuid, ${actor.userId}::uuid)
                                         AND app_can_see_workspace(${actor.orgId}::uuid, ${workspaceId}::uuid)) AS ok`.execute(trx)
          : sql<{ ok: boolean }>`SELECT app_is_org_member(${actor.orgId}::uuid, ${actor.userId}::uuid) AS ok`.execute(trx),
      );
      const ok = r.rows[0]?.ok === true;
      accessCache.set(key, { ok, at: Date.now() });
      return ok;
    };

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tell reverse proxies not to buffer
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    req.on('close', () => close());

    try {
      unsubscribe = await this.bus.subscribe([orgCh, userCh], (channel, raw) => {
        void (async () => {
          let msg: RealtimeMessage;
          try {
            msg = JSON.parse(raw) as RealtimeMessage;
          } catch {
            return;
          }
          if (msg.k === 'hint' && channel === orgCh) {
            if (await canSee(msg.hint.workspaceId)) send('hint', msg.hint);
          } else if (msg.k === 'notification' && channel === userCh) {
            send('notification', msg.notification); // user-private channel: nothing else to check
          } // anything else (e.g. a "notification" arriving on the shared org channel) is dropped
        })().catch(() => undefined);
      });
    } catch (e) {
      close('unavailable');
      return;
    }
    send('ready', {});

    timer = setInterval(() => {
      void (async () => {
        if (closed) return;
        res.write(': ping\n\n');
        const [session, member] = await Promise.all([this.sessions.validate(token), canSee()]);
        if (!session) close('session_ended');
        else if (!member) close('access_revoked');
      })().catch(() => undefined);
    }, this.config.sseHeartbeatMs);
  }
}
