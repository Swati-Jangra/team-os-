import { Body, Controller, Get, Inject, Patch, Post } from '@nestjs/common';
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  type CreateOrganizationInput,
  type UpdateOrganizationInput,
} from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import { CurrentActor, CurrentUser, RateLimit, RequirePermission } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { OrganizationsService } from './organizations.service';

@Controller('organizations')
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly orgs: OrganizationsService) {}

  @Post()
  @RateLimit({ limit: 20, windowSec: 3600 })
  create(@CurrentUser() user: UserActor, @Body(new ZodPipe(createOrganizationSchema)) body: CreateOrganizationInput) {
    return this.orgs.create(user, body);
  }

  @Get()
  list(@CurrentUser() user: UserActor) {
    return this.orgs.listForUser(user.userId);
  }

  @Get(':orgId')
  @RequirePermission('org:read')
  get(@CurrentActor() actor: RequestActor) {
    return this.orgs.get(actor);
  }

  @Patch(':orgId')
  @RequirePermission('org:update')
  update(@CurrentActor() actor: RequestActor, @Body(new ZodPipe(updateOrganizationSchema)) body: UpdateOrganizationInput) {
    return this.orgs.update(actor, body);
  }
}
