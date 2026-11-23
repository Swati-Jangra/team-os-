import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  addDependencySchema,
  applyPlanSchema,
  planRequestSchema,
  type ApplyPlanInput,
  type PlanRequestInput,
  commentBodySchema,
  createMilestoneSchema,
  createProjectSchema,
  createTaskSchema,
  listProjectsQuerySchema,
  listTasksQuerySchema,
  updateMilestoneSchema,
  updateProjectSchema,
  updateTaskSchema,
  uuidSchema,
  type AddDependencyInput,
  type CommentBodyInput,
  type CreateMilestoneInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type UpdateMilestoneInput,
  type UpdateProjectInput,
  type UpdateTaskInput,
} from '@teamos/validation';
import type { z } from 'zod';
import type { RequestActor } from '../../common/actor';
import { CurrentActor, RequirePermission } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { ActivityService } from './activity.service';
import { CommentsService } from './comments.service';
import { MilestonesService } from './milestones.service';
import { PlanService } from './plan.service';
import { ProjectsService } from './projects.service';
import { TasksService } from './tasks.service';

const id = () => new ZodPipe(uuidSchema);

@Controller('organizations/:orgId/projects')
export class ProjectsController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(MilestonesService) private readonly milestones: MilestonesService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(PlanService) private readonly plans: PlanService,
  ) {}

  /** Read-only AI proposal; nothing is created. */
  @Post(':projectId/plan')
  @HttpCode(200)
  @RequirePermission('ai:use')
  propose(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string, @Body(new ZodPipe(planRequestSchema)) body: PlanRequestInput) {
    return this.plans.propose(a, pid, body.goal);
  }

  /** Creates the human-reviewed tasks + dependencies atomically. */
  @Post(':projectId/plan/apply')
  @HttpCode(201)
  @RequirePermission('task:create')
  applyPlan(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string, @Body(new ZodPipe(applyPlanSchema)) body: ApplyPlanInput) {
    return this.plans.apply(a, pid, body);
  }

  @Get()
  @RequirePermission('project:read')
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listProjectsQuerySchema)) q: z.infer<typeof listProjectsQuerySchema>) {
    return this.projects.list(a, q);
  }

  @Post()
  @RequirePermission('project:create')
  create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(createProjectSchema)) body: CreateProjectInput) {
    return this.projects.create(a, body);
  }

  @Get(':projectId')
  @RequirePermission('project:read')
  get(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string) {
    return this.projects.get(a, pid);
  }

  @Patch(':projectId')
  @RequirePermission('project:update')
  update(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string, @Body(new ZodPipe(updateProjectSchema)) body: UpdateProjectInput) {
    return this.projects.update(a, pid, body);
  }

  @Delete(':projectId')
  @HttpCode(200)
  @RequirePermission('project:delete')
  async remove(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string) {
    await this.projects.remove(a, pid);
    return { deleted: true };
  }

  @Get(':projectId/milestones')
  @RequirePermission('project:read')
  listMilestones(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string) {
    return this.milestones.list(a, pid);
  }

  @Post(':projectId/milestones')
  @RequirePermission('project:update')
  createMilestone(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string, @Body(new ZodPipe(createMilestoneSchema)) body: CreateMilestoneInput) {
    return this.milestones.create(a, pid, body);
  }

  @Get(':projectId/tasks')
  @RequirePermission('task:read')
  listTasks(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string, @Query(new ZodPipe(listTasksQuerySchema)) q: z.infer<typeof listTasksQuerySchema>) {
    return this.tasks.list(a, pid, q);
  }

  @Post(':projectId/tasks')
  @RequirePermission('task:create')
  createTask(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string, @Body(new ZodPipe(createTaskSchema)) body: CreateTaskInput) {
    return this.tasks.create(a, pid, body);
  }

  @Get(':projectId/activity')
  @RequirePermission('project:read')
  projectActivity(@CurrentActor() a: RequestActor, @Param('projectId', id()) pid: string) {
    return this.activity.forProject(a, pid);
  }
}

@Controller('organizations/:orgId/milestones')
export class MilestonesController {
  constructor(@Inject(MilestonesService) private readonly milestones: MilestonesService) {}

  @Patch(':milestoneId')
  @RequirePermission('project:update')
  update(@CurrentActor() a: RequestActor, @Param('milestoneId', id()) mid: string, @Body(new ZodPipe(updateMilestoneSchema)) body: UpdateMilestoneInput) {
    return this.milestones.update(a, mid, body);
  }

  @Delete(':milestoneId')
  @HttpCode(200)
  @RequirePermission('project:update')
  async remove(@CurrentActor() a: RequestActor, @Param('milestoneId', id()) mid: string) {
    await this.milestones.remove(a, mid);
    return { deleted: true };
  }
}

@Controller('organizations/:orgId/tasks')
export class TasksController {
  constructor(
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(CommentsService) private readonly comments: CommentsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /** Declared before `:taskId` so "mine" is not parsed as an id. */
  @Get('mine')
  @RequirePermission('task:read')
  mine(@CurrentActor() a: RequestActor) {
    return this.tasks.mine(a);
  }

  @Get(':taskId')
  @RequirePermission('task:read')
  get(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string) {
    return this.tasks.get(a, tid);
  }

  @Patch(':taskId')
  @RequirePermission('task:update')
  update(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string, @Body(new ZodPipe(updateTaskSchema)) body: UpdateTaskInput) {
    return this.tasks.update(a, tid, body);
  }

  @Delete(':taskId')
  @HttpCode(200)
  @RequirePermission('task:delete')
  async remove(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string) {
    await this.tasks.remove(a, tid);
    return { deleted: true };
  }

  @Get(':taskId/activity')
  @RequirePermission('task:read')
  async taskActivity(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string) {
    const t = await this.tasks.get(a, tid);
    return this.activity.forProject(a, t.projectId, tid);
  }

  @Post(':taskId/dependencies')
  @RequirePermission('task:update')
  addDependency(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string, @Body(new ZodPipe(addDependencySchema)) body: AddDependencyInput) {
    return this.tasks.addDependency(a, tid, body.dependsOnTaskId);
  }

  @Delete(':taskId/dependencies/:dependsOnId')
  @HttpCode(200)
  @RequirePermission('task:update')
  async removeDependency(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string, @Param('dependsOnId', id()) dep: string) {
    await this.tasks.removeDependency(a, tid, dep);
    return { deleted: true };
  }

  @Get(':taskId/comments')
  @RequirePermission('comment:read')
  listComments(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string) {
    return this.comments.list(a, tid);
  }

  @Post(':taskId/comments')
  @RequirePermission('comment:create')
  createComment(@CurrentActor() a: RequestActor, @Param('taskId', id()) tid: string, @Body(new ZodPipe(commentBodySchema)) body: CommentBodyInput) {
    return this.comments.create(a, tid, body.body);
  }
}

@Controller('organizations/:orgId/comments')
export class CommentsController {
  constructor(@Inject(CommentsService) private readonly comments: CommentsService) {}

  @Patch(':commentId')
  @RequirePermission('comment:create')
  update(@CurrentActor() a: RequestActor, @Param('commentId', id()) cid: string, @Body(new ZodPipe(commentBodySchema)) body: CommentBodyInput) {
    return this.comments.update(a, cid, body.body);
  }

  @Delete(':commentId')
  @HttpCode(200)
  @RequirePermission('comment:create')
  async remove(@CurrentActor() a: RequestActor, @Param('commentId', id()) cid: string) {
    await this.comments.remove(a, cid);
    return { deleted: true };
  }
}
