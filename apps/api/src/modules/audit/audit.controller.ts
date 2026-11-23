import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationQuerySchema } from '@teamos/validation';
import { Paged } from '../../common/envelope';
import { CurrentActor, RequirePermission } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import type { RequestActor } from '../../common/actor';
import { AuditService } from './audit.service';

const auditQuerySchema = paginationQuerySchema.extend({
  action: z.string().max(100).optional(),
  actorId: z.string().uuid().optional(),
});

@Controller('organizations/:orgId/audit-logs')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit:read')
  async list(
    @CurrentActor() actor: RequestActor,
    @Query(new ZodPipe(auditQuerySchema)) q: z.infer<typeof auditQuerySchema>,
  ) {
    const { items, meta } = await this.audit.list(actor, q);
    return new Paged(items, meta);
  }
}
