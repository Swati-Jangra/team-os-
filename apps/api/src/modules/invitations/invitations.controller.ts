import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  acceptInvitationSchema,
  createInvitationSchema,
  uuidSchema,
  type AcceptInvitationInput,
  type CreateInvitationInput,
} from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import type { AuthedUser } from '../../common/express.d';
import { CurrentActor, CurrentUser, RateLimit, RequirePermission, SessionInfo } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { InvitationsService } from './invitations.service';

@Controller('organizations/:orgId/invitations')
export class OrgInvitationsController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  @Post()
  @RequirePermission('member:invite')
  create(@CurrentActor() actor: RequestActor, @Body(new ZodPipe(createInvitationSchema)) body: CreateInvitationInput) {
    return this.invitations.create(actor, body);
  }

  @Get()
  @RequirePermission('member:invite')
  list(@CurrentActor() actor: RequestActor) {
    return this.invitations.list(actor);
  }

  @Delete(':invitationId')
  @HttpCode(200)
  @RequirePermission('member:invite')
  async revoke(@CurrentActor() actor: RequestActor, @Param('invitationId', new ZodPipe(uuidSchema)) id: string) {
    await this.invitations.revoke(actor, id);
    return { revoked: true };
  }
}

@Controller('invitations')
export class InvitationsController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  @Post('accept')
  @HttpCode(200)
  @RateLimit({ limit: 20, windowSec: 3600 })
  accept(
    @CurrentUser() user: UserActor,
    @SessionInfo() session: AuthedUser,
    @Body(new ZodPipe(acceptInvitationSchema)) body: AcceptInvitationInput,
  ) {
    return this.invitations.accept({ ...user, email: session.email }, body);
  }
}
