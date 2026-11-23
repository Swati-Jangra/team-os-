import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '@teamos/shared';
import { isRoleName } from '@teamos/permissions';
import { uuidSchema } from '@teamos/validation';
import { DbService } from '../../db/db.service';

/**
 * Resolves tenant context for every route with an `:orgId` path parameter.
 * The org id from the URL is NOT trusted: it is only honoured if the authenticated user
 * has an active membership in it, looked up server-side. Non-members get 404 so the
 * existence of other tenants is not revealed.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const orgId = req.params?.orgId;
    if (orgId === undefined) return true;
    if (!req.auth) throw new AppError('UNAUTHENTICATED');

    const parsed = uuidSchema.safeParse(orgId);
    if (!parsed.success) throw new AppError('NOT_FOUND');

    const membership = await this.dbs.run({ userId: req.auth.userId }, (trx) =>
      trx
        .selectFrom('organizationMembers as m')
        .innerJoin('organizations as o', 'o.id', 'm.organizationId')
        .select('m.role')
        .where('m.organizationId', '=', parsed.data)
        .where('m.userId', '=', req.auth!.userId)
        .where('m.deletedAt', 'is', null)
        .where('o.deletedAt', 'is', null)
        .executeTakeFirst(),
    );
    if (!membership || !isRoleName(membership.role)) throw new AppError('NOT_FOUND');

    req.tenant = { orgId: parsed.data, role: membership.role };
    return true;
  }
}
