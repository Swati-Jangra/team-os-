// a side-effect import would be emitted to JS and crash the compiled build, so this must stay a triple-slash reference
/* eslint-disable-next-line @typescript-eslint/triple-slash-reference */
/// <reference path="./express.d.ts" />
import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '@teamos/shared';
import type { Permission } from '@teamos/permissions';
import type { RequestActor, UserActor } from './actor';

export const IS_PUBLIC = 'isPublic';
export const PERMISSION_KEY = 'permission';
export const RATE_LIMIT_KEY = 'rateLimit';

/** Route needs no session (register, login, ...). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route requires this permission in the org resolved from `:orgId`. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

export interface RateLimitOptions {
  limit: number;
  windowSec: number;
  /** `ip` (default) or `ip-email` (also keys on body.email, to slow targeted guessing). */
  scope?: 'ip' | 'ip-email';
}
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

/** Authenticated user without org context. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): UserActor => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  return { userId: req.auth.userId, requestId: req.id, ip: clientIp(req) };
});

/** Authenticated user + validated org membership. Only valid on routes with `:orgId`. */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestActor => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth || !req.tenant) throw new AppError('FORBIDDEN');
  return {
    userId: req.auth.userId,
    orgId: req.tenant.orgId,
    role: req.tenant.role,
    requestId: req.id,
    ip: clientIp(req),
  };
});

export const SessionInfo = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  return req.auth;
});
