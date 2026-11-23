import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { Database } from '@teamos/database';
import type { AppConfig } from './common/app-config';
import { EnvelopeInterceptor } from './common/envelope';
import { ErrorsFilter } from './common/errors.filter';
import { AuthGuard } from './common/guards/auth.guard';
import { PermissionGuard } from './common/guards/permission.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import type { RateLimiter } from './common/rate-limit/rate-limiter';
import { LocalProvider, type AIProvider } from '@teamos/ai-core';
import { APP_CONFIG, AI_PROVIDER, DB, GITHUB_CLIENT, GOOGLE_CLIENT, RATE_LIMITER, REALTIME } from './common/tokens';
import { DocumentsController } from './modules/documents/documents.controller';
import { DocumentsService } from './modules/documents/documents.service';
import { KnowledgeController } from './modules/knowledge/knowledge.controller';
import { KnowledgeService } from './modules/knowledge/knowledge.service';
import { MemoryRealtimeBus, type RealtimeBus } from './common/realtime/bus';
import { NotificationPreferencesController, NotificationsController } from './modules/notifications/notifications.controller';
import { NotificationsService } from './modules/notifications/notifications.service';
import { StreamController } from './modules/notifications/stream.controller';
import { DbModule } from './db/db.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './modules/health/health.controller';
import { InvitationsController, OrgInvitationsController } from './modules/invitations/invitations.controller';
import { InvitationsService } from './modules/invitations/invitations.service';
import { MembersController } from './modules/members/members.controller';
import { MembersService } from './modules/members/members.service';
import { OrganizationsController } from './modules/organizations/organizations.controller';
import { OrganizationsService } from './modules/organizations/organizations.service';
import { OutboxModule } from './modules/outbox/outbox.module';
import { ActivityService } from './modules/projects/activity.service';
import { CommentsService } from './modules/projects/comments.service';
import { MilestonesService } from './modules/projects/milestones.service';
import {
  CommentsController,
  MilestonesController,
  ProjectsController,
  TasksController,
} from './modules/projects/projects.controller';
import { ProjectsService } from './modules/projects/projects.service';
import { TasksService } from './modules/projects/tasks.service';
import { AgentActionsService } from './modules/agents/agent-actions.service';
import { AgentsController } from './modules/agents/agents.controller';
import { RiskService } from './modules/agents/risk.service';
import { PlanService } from './modules/projects/plan.service';
import { MeetingsController } from './modules/meetings/meetings.controller';
import { MeetingsService } from './modules/meetings/meetings.service';
import { IntegrationsController, IntegrationsPublicController } from './modules/integrations/integrations.controller';
import { IntegrationsService } from './modules/integrations/integrations.service';
import type { GitHubClient, GoogleClient } from '@teamos/integrations';
import { EmailService } from './modules/integrations/email.service';
import { GoogleController, GooglePublicController } from './modules/integrations/google.controller';
import { GoogleService } from './modules/integrations/google.service';
import { WorkspacesController } from './modules/workspaces/workspaces.controller';
import { WorkspacesService } from './modules/workspaces/workspaces.service';

export interface AppDeps {
  db: Database;
  config: AppConfig;
  rateLimiter: RateLimiter;
  /** Live-update subscriber (Redis in production). Defaults to an in-process bus. */
  realtime?: RealtimeBus;
  /** AI provider (OpenAI-compatible in production; the offline LocalProvider by default). */
  ai?: AIProvider;
  /** GitHub API client; absent when integrations are not configured. */
  github?: GitHubClient;
  /** Google OAuth/Calendar/Gmail client; absent when Google integrations are not configured. */
  google?: GoogleClient;
}

@Module({})
export class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      imports: [DbModule, AuditModule, OutboxModule, AuthModule],
      controllers: [
        HealthController,
        OrganizationsController,
        WorkspacesController,
        MembersController,
        OrgInvitationsController,
        InvitationsController,
        ProjectsController,
        MilestonesController,
        TasksController,
        CommentsController,
        NotificationsController,
        NotificationPreferencesController,
        StreamController,
        DocumentsController,
        KnowledgeController,
        MeetingsController,
        AgentsController,
        IntegrationsController,
        IntegrationsPublicController,
        GoogleController,
        GooglePublicController,
      ],
      providers: [
        { provide: DB, useValue: deps.db },
        { provide: APP_CONFIG, useValue: deps.config },
        { provide: RATE_LIMITER, useValue: deps.rateLimiter },
        { provide: REALTIME, useValue: deps.realtime ?? new MemoryRealtimeBus() },
        { provide: AI_PROVIDER, useValue: deps.ai ?? new LocalProvider() },
        { provide: GITHUB_CLIENT, useValue: deps.github ?? null },
        IntegrationsService,
        { provide: GOOGLE_CLIENT, useValue: deps.google ?? null },
        GoogleService,
        EmailService,
        DocumentsService,
        KnowledgeService,
        NotificationsService,
        OrganizationsService,
        WorkspacesService,
        MembersService,
        InvitationsService,
        ProjectsService,
        MilestonesService,
        TasksService,
        PlanService,
        MeetingsService,
        AgentActionsService,
        RiskService,
        CommentsService,
        ActivityService,
        // Guard order matters: rate limit -> authenticate (+CSRF) -> resolve tenant -> check permission.
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_FILTER, useClass: ErrorsFilter },
        { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      ],
      // exported so feature modules (auth, ...) can inject them; the module is global
      exports: [DB, APP_CONFIG, RATE_LIMITER, REALTIME],
      global: true,
    };
  }
}
