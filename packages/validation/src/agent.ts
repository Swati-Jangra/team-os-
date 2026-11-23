import { z } from 'zod';
import { paginationQuerySchema, uuidSchema } from './common';

export const AGENT_NAMES = ['DEPENDENCY_RISK', 'TASK_MANAGEMENT'] as const;
export const AGENT_ACTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTING', 'EXECUTED', 'FAILED', 'STALE'] as const;

export const agentProposalSchema = z.object({ agent: z.enum(AGENT_NAMES).optional() });
export type AgentProposalInput = z.infer<typeof agentProposalSchema>;

export const decideActionSchema = z.object({ note: z.string().trim().max(1000).optional() });
export type DecideActionInput = z.infer<typeof decideActionSchema>;

export const listAgentActionsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(AGENT_ACTION_STATUSES).optional(),
  projectId: uuidSchema.optional(),
});

export const listRisksQuerySchema = z.object({ workspaceId: uuidSchema.optional() });
