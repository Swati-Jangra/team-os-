import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '@teamos/shared';
import { hasPermission, type Permission } from '@teamos/permissions';
import { PERMISSION_KEY } from '../decorators';

/** Enforces `@RequirePermission()` against the server-resolved org role. Deny by default. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.tenant) throw new AppError('FORBIDDEN');
    if (!hasPermission(req.tenant.role, required)) throw new AppError('FORBIDDEN');
    return true;
  }
}
