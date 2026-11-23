import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError, safeEqual } from '@teamos/shared';
import { IS_PUBLIC } from '../decorators';
import { CSRF_HEADER, SESSION_COOKIE, SessionService } from '../../modules/auth/session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Authenticates via the httpOnly session cookie and enforces CSRF (header must equal the
 * server-stored per-session token) on state-changing requests. @Public routes are skipped;
 * they carry no session so there is nothing for CSRF to ride on.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token || typeof token !== 'string') throw new AppError('UNAUTHENTICATED');

    const auth = await this.sessions.validate(token);
    if (!auth) throw new AppError('UNAUTHENTICATED');

    if (!SAFE_METHODS.has(req.method)) {
      const header = req.header(CSRF_HEADER);
      if (!header || !safeEqual(header, auth.csrfToken)) throw new AppError('CSRF_FAILED');
    }

    req.auth = auth;
    return true;
  }
}
