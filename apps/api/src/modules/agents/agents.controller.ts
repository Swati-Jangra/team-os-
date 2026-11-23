import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { agentProposalSchema, decideActionSchema, listAgentActionsQuerySchema, listRisksQuerySchema, uuidSchema, type AgentProposalInput, type DecideActionInput } from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { CurrentActor, RequirePermission } from '../../common/decorators';
import { Paged } from '../../common/envelope';
import { ZodPipe } from '../../common/zod.pipe';
import { AgentActionsService } from './agent-actions.service';
import { RiskService } from './risk.service';

const id = () => new ZodPipe(uuidSchema);

@Controller('organizations/:orgId')
export class AgentsController {
  constructor(
    @Inject(RiskService) private readonly risks: RiskService,
    @Inject(AgentActionsService) private readonly actions: AgentActionsService,
  ) {}

  @Get('risks')
  @RequirePermission('project:read')
  orgRisks(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listRisksQuerySchema)) q: z.infer<typeof listRisksQuerySchema>) {
    return this.risks.analyze(a, q);
  }

  @Get('projects/:projectId/risks')
  @RequirePermission('project:read')
  projectRisks(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string) {
    return this.risks.analyze(a, { projectId: pid });
  }

  /** Agents only PROPOSE. Nothing changes until a person with approval rights decides. */
  @Post('projects/:projectId/agent-proposals')
  @HttpCode(200)
  @RequirePermission('ai:use')
  propose(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string, @Body(new ZodPipe(agentProposalSchema)) body: AgentProposalInput) {
    return this.actions.propose(a, pid, body.agent);
  }

  @Get('agent-actions')
  @RequirePermission('approval:read')
  async list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listAgentActionsQuerySchema)) q: z.infer<typeof listAgentActionsQuerySchema>) {
    const { items, meta } = await this.actions.list(a, q);
    return new Paged(items, meta);
  }

  @Get('agent-actions/:actionId')
  @RequirePermission('approval:read')
  get(@CurrentActor() a: RequestActor, @Param('actionId', id()) aid: string) {
    return this.actions.get(a, aid);
  }

  @Post('agent-actions/:actionId/approve')
  @HttpCode(200)
  @RequirePermission('approval:decide')
  approve(@CurrentActor() a: RequestActor, @Param('actionId', id()) aid: string, @Body(new ZodPipe(decideActionSchema)) body: DecideActionInput) {
    return this.actions.approve(a, aid, body.note);
  }

  @Post('agent-actions/:actionId/reject')
  @HttpCode(200)
  @RequirePermission('approval:decide')
  reject(@CurrentActor() a: RequestActor, @Param('actionId', id()) aid: string, @Body(new ZodPipe(decideActionSchema)) body: DecideActionInput) {
    return this.actions.reject(a, aid, body.note);
  }

  @Post('agent-actions/:actionId/retry')
  @HttpCode(200)
  @RequirePermission('approval:decide')
  retry(@CurrentActor() a: RequestActor, @Param('actionId', id()) aid: string) {
    return this.actions.retry(a, aid);
  }
}
