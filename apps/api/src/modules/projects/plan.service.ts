import { Inject, Injectable } from '@nestjs/common';
import { AIProviderError, PROJECT_PLAN_PROMPT, parseModelJson, projectPlanSchema, type AIProvider, type ProjectPlan } from '@teamos/ai-core';
import { AppError } from '@teamos/shared';
import type { ApplyPlanInput } from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import type { RateLimiter } from '../../common/rate-limit/rate-limiter';
import { AI_PROVIDER, RATE_LIMITER } from '../../common/tokens';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { TasksService, type TaskDto } from './tasks.service';

/**
 * AI planning: PROPOSE a task breakdown, never apply it. The proposal is returned to the client; creating tasks is a
 * separate, human-confirmed call (`apply`) that goes through the normal task rules and audit trail.
 */
@Injectable()
export class PlanService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AI_PROVIDER) private readonly ai: AIProvider,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async propose(a: RequestActor, projectId: string, goal: string | undefined): Promise<{ tasks: ProjectPlan['tasks']; provider: string; model: string }> {
    const r = await this.limiter.hit(`ai:plan:${a.userId}`, 3600);
    if (r.count > 30) throw new AppError('RATE_LIMITED', 'AI usage limit reached. Try again later.', { retryAfterSec: r.retryAfterSec });
    const proj = await this.dbs.run({ userId: a.userId, orgId: a.orgId }, (trx) =>
      trx.selectFrom('projects').select(['name', 'description']).where('id', '=', projectId).where('deletedAt', 'is', null).executeTakeFirst());
    if (!proj) throw new AppError('NOT_FOUND');
    const brief = [goal?.trim(), proj.description?.trim()].filter(Boolean).join('\n\n');
    if (brief.length < 10) throw new AppError('VALIDATION_FAILED', 'Describe the goal (or add a project description) so there is something to plan.');

    let chat;
    try {
      chat = await this.ai.chat({
        json: true, temperature: 0.2, maxTokens: 2500,
        messages: [
          { role: 'system', content: PROJECT_PLAN_PROMPT },
          { role: 'user', content: `Project: ${proj.name}\n\n<goal>\n${brief.slice(0, 4000)}\n</goal>` },
        ],
      });
    } catch (e) {
      if (e instanceof AIProviderError) throw new AppError('AI_UNAVAILABLE', 'The AI service is unavailable right now. Please try again.');
      throw e;
    }
    await this.dbs.run({ userId: a.userId, orgId: a.orgId }, (trx) =>
      trx.insertInto('aiUsage').values({ organizationId: a.orgId, userId: a.userId, feature: 'plan', provider: this.ai.name, model: chat.model, inputTokens: chat.usage.inputTokens, outputTokens: chat.usage.outputTokens }).execute());
    let plan: ProjectPlan;
    try {
      plan = parseModelJson(projectPlanSchema, chat.text);
    } catch {
      throw new AppError('AI_UNAVAILABLE', 'The AI returned a plan that could not be understood. Please try again.');
    }
    // drop dependency indexes that do not point at an earlier task (models make mistakes; cycles must be impossible)
    const tasks = plan.tasks.map((t, i) => ({ ...t, dependsOn: [...new Set(t.dependsOn.filter((d) => d < i))] }));
    return { tasks, provider: this.ai.name, model: chat.model };
  }

  /** Creates the (human-reviewed) tasks and their dependencies atomically. */
  apply(a: RequestActor, projectId: string, input: ApplyPlanInput): Promise<TaskDto[]> {
    return this.dbs.run({ userId: a.userId, orgId: a.orgId }, async (trx) => {
      const created: TaskDto[] = [];
      let workspaceId = '';
      for (const t of input.tasks) {
        const dto = await this.tasks.createInTx(trx, a, projectId, {
          title: t.title, description: t.description ?? undefined, priority: t.priority ?? undefined, estimateHours: t.estimateHours ?? null,
        });
        created.push(dto);
        workspaceId = dto.workspaceId;
      }
      for (const [i, t] of input.tasks.entries()) {
        for (const dep of t.dependsOn) {
          // dependsOn only points at earlier tasks (validated), so the graph stays acyclic by construction
          await trx.insertInto('taskDependencies').values({
            organizationId: a.orgId, workspaceId, taskId: created[i]!.id, dependsOnTaskId: created[dep]!.id, createdBy: a.userId,
          }).execute();
        }
      }
      await this.audit.record(trx, this.audit.forActor(a, { workspaceId, action: 'project.plan_applied', targetType: 'project', targetId: projectId, metadata: { tasks: created.length } }));
      await this.outbox.enqueue(trx, 'task.dependency_changed.v1', { organizationId: a.orgId, workspaceId, projectId, taskId: created[0]!.id, changedByUserId: a.userId }, { orgId: a.orgId, workspaceId });
      return created;
    });
  }
}
