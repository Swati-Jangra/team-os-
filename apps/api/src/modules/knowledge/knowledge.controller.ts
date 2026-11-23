import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { askSchema, knowledgeSearchSchema, type AskInput, type KnowledgeSearchInput } from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { CurrentActor, RequirePermission } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { KnowledgeService } from './knowledge.service';

@Controller('organizations/:orgId/knowledge')
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  @Post('search')
  @HttpCode(200)
  @RequirePermission('document:read')
  async search(@CurrentActor() a: RequestActor, @Body(new ZodPipe(knowledgeSearchSchema)) body: KnowledgeSearchInput) {
    return { results: await this.knowledge.search(a, body) };
  }

  @Post('ask')
  @HttpCode(200)
  @RequirePermission('ai:use')
  ask(@CurrentActor() a: RequestActor, @Body(new ZodPipe(askSchema)) body: AskInput) {
    return this.knowledge.ask(a, body);
  }
}
