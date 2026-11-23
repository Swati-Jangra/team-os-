import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import {
  updateMemberRoleSchema,
  uuidSchema,
  type UpdateMemberRoleInput,
} from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { CurrentActor, RequirePermission } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { MembersService } from './members.service';

@Controller('organizations/:orgId/members')
export class MembersController {
  constructor(@Inject(MembersService) private readonly members: MembersService) {}

  @Get()
  @RequirePermission('member:read')
  list(@CurrentActor() actor: RequestActor) {
    return this.members.list(actor);
  }

  @Put(':userId/role')
  @RequirePermission('member:role_update')
  updateRole(
    @CurrentActor() actor: RequestActor,
    @Param('userId', new ZodPipe(uuidSchema)) userId: string,
    @Body(new ZodPipe(updateMemberRoleSchema)) body: UpdateMemberRoleInput,
  ) {
    return this.members.updateRole(actor, userId, body.role);
  }

  @Delete(':userId')
  @HttpCode(200)
  @RequirePermission('member:remove')
  async remove(@CurrentActor() actor: RequestActor, @Param('userId', new ZodPipe(uuidSchema)) userId: string) {
    await this.members.remove(actor, userId);
    return { removed: true };
  }
}
