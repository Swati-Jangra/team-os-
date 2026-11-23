import type { RoleName } from '@teamos/permissions';

export interface AuthedUser {
  userId: string;
  sessionId: string;
  csrfToken: string;
  email: string;
  name: string;
}

export interface ResolvedTenant {
  orgId: string;
  role: RoleName;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      auth?: AuthedUser;
      tenant?: ResolvedTenant;
    }
  }
}
