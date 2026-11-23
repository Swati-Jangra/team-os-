'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@teamos/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/features/org/api';
import type { ProjectStatus, TaskPriority, TaskStatus } from './meta';

export interface ProjectDto {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  ownerId: string | null;
  startDate: string | null;
  dueDate: string | null;
  createdAt: string;
  taskCount: number;
  doneCount: number;
}
export interface MilestoneDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  dueDate: string | null;
  status: 'OPEN' | 'COMPLETED';
  taskCount: number;
  doneCount: number;
}
export interface TaskDto {
  id: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  reporterId: string;
  milestoneId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateHours: number | null;
  labels: string[];
  position: number;
  completedAt: string | null;
  openBlockers: number;
  commentCount: number;
}
export interface TaskRef {
  id: string;
  identifier: string;
  title: string;
  status: TaskStatus;
}
export interface TaskDetailDto extends TaskDto {
  blockedBy: TaskRef[];
  blocks: TaskRef[];
}
export interface CommentDto {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  editedAt: string | null;
  createdAt: string;
}
export interface ActivityDto {
  id: string;
  projectId: string;
  taskId: string | null;
  actorId: string | null;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const k = {
  projects: (o: string) => ['org', o, 'projects'] as const,
  project: (o: string, p: string) => ['org', o, 'projects', p] as const,
  tasks: (o: string, p: string) => ['org', o, 'projects', p, 'tasks'] as const,
  milestones: (o: string, p: string) => ['org', o, 'projects', p, 'milestones'] as const,
  activity: (o: string, p: string) => ['org', o, 'projects', p, 'activity'] as const,
  task: (o: string, t: string) => ['org', o, 'task', t] as const,
  taskActivity: (o: string, t: string) => ['org', o, 'task', t, 'activity'] as const,
  comments: (o: string, t: string) => ['org', o, 'task', t, 'comments'] as const,
  mine: (o: string) => ['org', o, 'my-tasks'] as const,
};

const base = (o: string) => `/organizations/${o}`;

export const useProjects = (orgId: string) =>
  useQuery({ queryKey: k.projects(orgId), queryFn: () => api<ProjectDto[]>(`${base(orgId)}/projects`) });
export const useProject = (orgId: string, id: string) =>
  useQuery({ queryKey: k.project(orgId, id), queryFn: () => api<ProjectDto>(`${base(orgId)}/projects/${id}`) });
export const useTasks = (orgId: string, projectId: string) =>
  useQuery({ queryKey: k.tasks(orgId, projectId), queryFn: () => api<TaskDto[]>(`${base(orgId)}/projects/${projectId}/tasks`) });
export const useMilestones = (orgId: string, projectId: string) =>
  useQuery({ queryKey: k.milestones(orgId, projectId), queryFn: () => api<MilestoneDto[]>(`${base(orgId)}/projects/${projectId}/milestones`) });
export const useProjectActivity = (orgId: string, projectId: string, enabled = true) =>
  useQuery({ queryKey: k.activity(orgId, projectId), queryFn: () => api<ActivityDto[]>(`${base(orgId)}/projects/${projectId}/activity`), enabled });
export const useTask = (orgId: string, id: string | null) =>
  useQuery({ queryKey: k.task(orgId, id ?? ''), queryFn: () => api<TaskDetailDto>(`${base(orgId)}/tasks/${id}`), enabled: !!id });
export const useTaskActivity = (orgId: string, id: string | null) =>
  useQuery({ queryKey: k.taskActivity(orgId, id ?? ''), queryFn: () => api<ActivityDto[]>(`${base(orgId)}/tasks/${id}/activity`), enabled: !!id });
export const useComments = (orgId: string, id: string | null) =>
  useQuery({ queryKey: k.comments(orgId, id ?? ''), queryFn: () => api<CommentDto[]>(`${base(orgId)}/tasks/${id}/comments`), enabled: !!id });
export const useMyTasks = (orgId: string) =>
  useQuery({ queryKey: k.mine(orgId), queryFn: () => api<TaskDto[]>(`${base(orgId)}/tasks/mine`) });

type TaskPatch = Partial<{
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  milestoneId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateHours: number | null;
  labels: string[];
  position: number;
}>;

export function useProjectMutations(orgId: string) {
  const qc = useQueryClient();
  const inv = (...keys: ReadonlyArray<readonly unknown[]>) => Promise.all(keys.map((key) => qc.invalidateQueries({ queryKey: key })));
  const onError = (e: unknown) => toast.error(errorMessage(e));
  const refreshProject = (projectId: string) =>
    inv(k.projects(orgId), k.project(orgId, projectId), k.milestones(orgId, projectId), k.activity(orgId, projectId), ['org', orgId, 'audit']);

  return {
    createProject: useMutation({
      mutationFn: (body: { workspaceId: string; name: string; key?: string; description?: string; startDate?: string | null; dueDate?: string | null }) =>
        api<ProjectDto>(`${base(orgId)}/projects`, { method: 'POST', body }),
      onSuccess: async () => {
        await inv(k.projects(orgId), ['org', orgId, 'audit']);
        toast.success('Project created');
      },
      onError,
    }),
    updateProject: useMutation({
      mutationFn: (v: { id: string; body: Partial<Pick<ProjectDto, 'name' | 'description' | 'status' | 'startDate' | 'dueDate'>> }) =>
        api<ProjectDto>(`${base(orgId)}/projects/${v.id}`, { method: 'PATCH', body: v.body }),
      onSuccess: async (_d, v) => {
        await refreshProject(v.id);
        toast.success('Project updated');
      },
      onError,
    }),
    deleteProject: useMutation({
      mutationFn: (id: string) => api(`${base(orgId)}/projects/${id}`, { method: 'DELETE' }),
      onSuccess: async () => {
        await inv(k.projects(orgId));
        toast.success('Project deleted');
      },
      onError,
    }),
    createTask: useMutation({
      mutationFn: (v: { projectId: string; body: { title: string; status?: TaskStatus; priority?: TaskPriority; milestoneId?: string | null; dueDate?: string | null } }) =>
        api<TaskDto>(`${base(orgId)}/projects/${v.projectId}/tasks`, { method: 'POST', body: v.body }),
      onSuccess: async (_d, v) => {
        await inv(k.tasks(orgId, v.projectId), k.projects(orgId), k.project(orgId, v.projectId), k.milestones(orgId, v.projectId), k.activity(orgId, v.projectId), k.mine(orgId));
      },
      onError,
    }),
    /** Optimistic: board drags must feel instant; rolls back (and tells the user why) on failure. */
    updateTask: useMutation({
      mutationFn: (v: { id: string; projectId: string; body: TaskPatch }) =>
        api<TaskDto>(`${base(orgId)}/tasks/${v.id}`, { method: 'PATCH', body: v.body }),
      onMutate: async (v) => {
        await qc.cancelQueries({ queryKey: k.tasks(orgId, v.projectId) });
        const prev = qc.getQueryData<TaskDto[]>(k.tasks(orgId, v.projectId));
        if (prev) {
          const { labels, ...rest } = v.body;
          qc.setQueryData<TaskDto[]>(
            k.tasks(orgId, v.projectId),
            prev.map((t) => (t.id === v.id ? { ...t, ...rest, ...(labels ? { labels } : {}) } : t)),
          );
        }
        return { prev };
      },
      onError: (e, v, ctx) => {
        if (ctx?.prev) qc.setQueryData(k.tasks(orgId, v.projectId), ctx.prev);
        toast.error(errorMessage(e));
      },
      onSettled: async (_d, _e, v) => {
        await inv(k.tasks(orgId, v.projectId), k.task(orgId, v.id), k.taskActivity(orgId, v.id), k.activity(orgId, v.projectId), k.projects(orgId), k.project(orgId, v.projectId), k.milestones(orgId, v.projectId), k.mine(orgId));
      },
    }),
    deleteTask: useMutation({
      mutationFn: (v: { id: string; projectId: string }) => api(`${base(orgId)}/tasks/${v.id}`, { method: 'DELETE' }),
      onSuccess: async (_d, v) => {
        await inv(k.tasks(orgId, v.projectId), k.projects(orgId), k.project(orgId, v.projectId), k.milestones(orgId, v.projectId), k.activity(orgId, v.projectId), k.mine(orgId));
        toast.success('Task deleted');
      },
      onError,
    }),
    addDependency: useMutation({
      mutationFn: (v: { id: string; projectId: string; dependsOnTaskId: string }) =>
        api(`${base(orgId)}/tasks/${v.id}/dependencies`, { method: 'POST', body: { dependsOnTaskId: v.dependsOnTaskId } }),
      onSuccess: async (_d, v) => {
        await inv(k.task(orgId, v.id), k.tasks(orgId, v.projectId), k.taskActivity(orgId, v.id));
      },
      onError,
    }),
    removeDependency: useMutation({
      mutationFn: (v: { id: string; projectId: string; dependsOnTaskId: string }) =>
        api(`${base(orgId)}/tasks/${v.id}/dependencies/${v.dependsOnTaskId}`, { method: 'DELETE' }),
      onSuccess: async (_d, v) => {
        await inv(k.task(orgId, v.id), k.tasks(orgId, v.projectId), k.taskActivity(orgId, v.id));
      },
      onError,
    }),
    createMilestone: useMutation({
      mutationFn: (v: { projectId: string; body: { name: string; dueDate?: string | null } }) =>
        api<MilestoneDto>(`${base(orgId)}/projects/${v.projectId}/milestones`, { method: 'POST', body: v.body }),
      onSuccess: async (_d, v) => {
        await inv(k.milestones(orgId, v.projectId), k.activity(orgId, v.projectId));
        toast.success('Milestone added');
      },
      onError,
    }),
    updateMilestone: useMutation({
      mutationFn: (v: { id: string; projectId: string; body: Partial<{ name: string; dueDate: string | null; status: 'OPEN' | 'COMPLETED' }> }) =>
        api<MilestoneDto>(`${base(orgId)}/milestones/${v.id}`, { method: 'PATCH', body: v.body }),
      onSuccess: async (_d, v) => {
        await inv(k.milestones(orgId, v.projectId), k.activity(orgId, v.projectId));
      },
      onError,
    }),
    deleteMilestone: useMutation({
      mutationFn: (v: { id: string; projectId: string }) => api(`${base(orgId)}/milestones/${v.id}`, { method: 'DELETE' }),
      onSuccess: async (_d, v) => {
        await inv(k.milestones(orgId, v.projectId), k.tasks(orgId, v.projectId), k.activity(orgId, v.projectId));
        toast.success('Milestone removed');
      },
      onError,
    }),
    addComment: useMutation({
      mutationFn: (v: { taskId: string; projectId: string; body: string }) =>
        api<CommentDto>(`${base(orgId)}/tasks/${v.taskId}/comments`, { method: 'POST', body: { body: v.body } }),
      onSuccess: async (_d, v) => {
        await inv(k.comments(orgId, v.taskId), k.tasks(orgId, v.projectId), k.taskActivity(orgId, v.taskId), k.task(orgId, v.taskId));
      },
      onError,
    }),
    editComment: useMutation({
      mutationFn: (v: { id: string; taskId: string; body: string }) =>
        api<CommentDto>(`${base(orgId)}/comments/${v.id}`, { method: 'PATCH', body: { body: v.body } }),
      onSuccess: async (_d, v) => {
        await inv(k.comments(orgId, v.taskId));
      },
      onError,
    }),
    deleteComment: useMutation({
      mutationFn: (v: { id: string; taskId: string; projectId: string }) => api(`${base(orgId)}/comments/${v.id}`, { method: 'DELETE' }),
      onSuccess: async (_d, v) => {
        await inv(k.comments(orgId, v.taskId), k.tasks(orgId, v.projectId), k.task(orgId, v.taskId));
      },
      onError,
    }),
  };
}
