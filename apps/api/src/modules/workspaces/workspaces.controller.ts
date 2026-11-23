import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  addWorkspaceMemberSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
  uuidSchema,
  type AddWorkspaceMemberInput,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
} from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { CurrentActor, RequirePermission } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { WorkspacesService } from './workspaces.service';

const wsId = () => new ZodPipe(uuidSchema);

@Controller('organizations/:orgId/workspaces')
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Post()
  @RequirePermission('workspace:create')
  create(@CurrentActor() actor: RequestActor, @Body(new ZodPipe(createWorkspaceSchema)) body: CreateWorkspaceInput) {
    return this.workspaces.create(actor, body);
  }

  @Get()
  @RequirePermission('workspace:read')
  list(@CurrentActor() actor: RequestActor) {
    return this.workspaces.list(actor);
  }

  @Get(':workspaceId')
  @RequirePermission('workspace:read')
  get(@CurrentActor() actor: RequestActor, @Param('workspaceId', wsId()) id: string) {
    return this.workspaces.get(actor, id);
  }

  @Patch(':workspaceId')
  @RequirePermission('workspace:update')
  update(
    @CurrentActor() actor: RequestActor,
    @Param('workspaceId', wsId()) id: string,
    @Body(new ZodPipe(updateWorkspaceSchema)) body: UpdateWorkspaceInput,
  ) {
    return this.workspaces.update(actor, id, body);
  }

  @Delete(':workspaceId')
  @HttpCode(200)
  @RequirePermission('workspace:delete')
  async remove(@CurrentActor() actor: RequestActor, @Param('workspaceId', wsId()) id: string) {
    await this.workspaces.remove(actor, id);
    return { deleted: true };
  }

  @Get(':workspaceId/members')
  @RequirePermission('workspace:read')
  listMembers(@CurrentActor() actor: RequestActor, @Param('workspaceId', wsId()) id: string) {
    return this.workspaces.listMembers(actor, id);
  }

  @Post(':workspaceId/members')
  @RequirePermission('workspace:update')
  addMember(
    @CurrentActor() actor: RequestActor,
    @Param('workspaceId', wsId()) id: string,
    @Body(new ZodPipe(addWorkspaceMemberSchema)) body: AddWorkspaceMemberInput,
  ) {
    return this.workspaces.addMember(actor, id, body);
  }

  @Delete(':workspaceId/members/:userId')
  @HttpCode(200)
  @RequirePermission('workspace:update')
  async removeMember(
    @CurrentActor() actor: RequestActor,
    @Param('workspaceId', wsId()) id: string,
    @Param('userId', wsId()) userId: string,
  ) {
    await this.workspaces.removeMember(actor, id, userId);
    return { removed: true };
  }
}
