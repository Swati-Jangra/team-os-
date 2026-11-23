import { z } from 'zod';
import { emailSchema, nameSchema, roleSchema, slugSchema } from './common';

export const createOrganizationSchema = z.object({
  name: nameSchema,
  slug: slugSchema.optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z
  .object({
    name: nameSchema.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const createWorkspaceSchema = z.object({
  name: nameSchema,
  slug: slugSchema.optional(),
  description: z.string().trim().max(500).optional(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z
  .object({
    name: nameSchema.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: roleSchema.default('DEVELOPER'),
  /** Optional: also add the invitee to these workspaces on acceptance. */
  workspaceIds: z.array(z.string().uuid()).max(50).optional(),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(200) });
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const updateMemberRoleSchema = z.object({ role: roleSchema });
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const addWorkspaceMemberSchema = z.object({
  userId: z.string().uuid(),
  role: roleSchema.default('DEVELOPER'),
});
export type AddWorkspaceMemberInput = z.infer<typeof addWorkspaceMemberSchema>;
