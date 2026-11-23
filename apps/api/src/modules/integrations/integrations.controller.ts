import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { connectRepoSchema, linkItemSchema, listExternalItemsQuerySchema, oauthCallbackQuerySchema, uuidSchema, type ConnectRepoInput } from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import type { AppConfig } from '../../common/app-config';
import { CurrentActor, CurrentUser, Public, RateLimit, RequirePermission } from '../../common/decorators';
import { Paged } from '../../common/envelope';
import { APP_CONFIG } from '../../common/tokens';
import { ZodPipe } from '../../common/zod.pipe';
import { IntegrationsService } from './integrations.service';

const id = () => new ZodPipe(uuidSchema);

@Controller('organizations/:orgId')
export class IntegrationsController {
  constructor(@Inject(IntegrationsService) private readonly svc: IntegrationsService) {}

  @Get('integrations')
  @RequirePermission('project:read')
  overview(@CurrentActor() a: RequestActor) {
    return this.svc.overview(a);
  }

  @Post('integrations/github/authorize')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  authorize(@CurrentActor() a: RequestActor) {
    return this.svc.startGitHub(a);
  }

  @Delete('integrations/:integrationId')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  async disconnect(@CurrentActor() a: RequestActor, @Param('integrationId', id()) iid: string) {
    await this.svc.disconnect(a, iid);
    return { disconnected: true };
  }

  @Get('integrations/:integrationId/available-repos')
  @RequirePermission('integration:manage')
  available(@CurrentActor() a: RequestActor, @Param('integrationId', id()) iid: string) {
    return this.svc.availableRepos(a, iid);
  }

  @Post('integrations/:integrationId/repos')
  @HttpCode(201)
  @RequirePermission('integration:manage')
  connectRepo(@CurrentActor() a: RequestActor, @Param('integrationId', id()) iid: string, @Body(new ZodPipe(connectRepoSchema)) body: ConnectRepoInput) {
    return this.svc.connectRepo(a, iid, body);
  }

  @Delete('integration-repos/:repoId')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  async disconnectRepo(@CurrentActor() a: RequestActor, @Param('repoId', id()) rid: string) {
    await this.svc.disconnectRepo(a, rid);
    return { disconnected: true };
  }

  @Post('integration-repos/:repoId/sync')
  @HttpCode(202)
  @RequirePermission('integration:manage')
  sync(@CurrentActor() a: RequestActor, @Param('repoId', id()) rid: string) {
    return this.svc.syncNow(a, rid);
  }

  @Get('external-items')
  @RequirePermission('project:read')
  async items(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listExternalItemsQuerySchema)) q: z.infer<typeof listExternalItemsQuerySchema>) {
    const { items, meta } = await this.svc.listItems(a, q);
    return new Paged(items, meta);
  }

  @Get('tasks/:taskId/links')
  @RequirePermission('task:read')
  links(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string) {
    return this.svc.taskLinks(a, tid);
  }

  @Post('tasks/:taskId/links')
  @HttpCode(201)
  @RequirePermission('task:update')
  link(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string, @Body(new ZodPipe(linkItemSchema)) body: { itemId: string }) {
    return this.svc.linkTask(a, tid, body.itemId);
  }

  @Delete('tasks/:taskId/links/:linkId')
  @HttpCode(200)
  @RequirePermission('task:update')
  async unlink(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string, @Param('linkId', id()) lid: string) {
    await this.svc.unlinkTask(a, tid, lid);
    return { unlinked: true };
  }
}

/** Routes without `:orgId`: the OAuth browser callback (session required) and the signed webhook receiver (public). */
@Controller()
export class IntegrationsPublicController {
  constructor(
    @Inject(IntegrationsService) private readonly svc: IntegrationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('integrations/github/callback')
  async callback(@CurrentUser() user: UserActor, @Query(new ZodPipe(oauthCallbackQuerySchema)) q: z.infer<typeof oauthCallbackQuerySchema>, @Res() res: Response) {
    const r = await this.svc.finishGitHub(user, q);
    const base = `${this.config.appUrl}/o/${r.orgId}/integrations`;
    res.redirect(302, r.ok ? `${base}?connected=github` : `${base}?error=github_denied`);
  }

  @Public()
  @RateLimit({ limit: 300, windowSec: 60 })
  @Post('webhooks/github/:repoId')
  @HttpCode(202)
  hook(
    @Param('repoId', id()) repoId: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature?: string,
    @Headers('x-github-event') event?: string,
    @Headers('x-github-delivery') delivery?: string,
  ) {
    return this.svc.receiveGitHub(repoId, req.rawBody, { signature, event, delivery }, req.body);
  }
}
