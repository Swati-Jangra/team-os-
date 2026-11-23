import type { RoleName } from '@teamos/permissions';

/**
 * Everything a service needs to know about who is acting and where, derived on the
 * server from the session + path-resolved membership. Never built from request bodies.
 */
export interface RequestActor {
  userId: string;
  orgId: string;
  role: RoleName;
  requestId: string;
  ip: string | null;
}

export interface UserActor {
  userId: string;
  requestId: string;
  ip: string | null;
}
