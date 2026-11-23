import { z } from 'zod';
import { ROLES } from '@teamos/permissions';

export const uuidSchema = z.string().uuid();

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

/** Min 10 chars, must mix letters and digits; max 128 to bound hashing cost. */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password must contain letters and numbers');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens');

export const nameSchema = z.string().trim().min(1).max(120);

export const roleSchema = z.enum(ROLES);

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
