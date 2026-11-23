'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { hasPermission, type Permission, type RoleName } from '@teamos/permissions';

interface OrgCtx {
  orgId: string;
  orgName: string;
  role: RoleName;
  userId: string;
  /** UI hint only — the API enforces every permission on the server. */
  can: (permission: Permission) => boolean;
}

const Ctx = createContext<OrgCtx | null>(null);

export function OrgProvider({
  value,
  children,
}: {
  value: { orgId: string; orgName: string; role: RoleName; userId: string };
  children: ReactNode;
}) {
  const ctx: OrgCtx = { ...value, can: (p) => hasPermission(value.role, p) };
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function useOrgContext(): OrgCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOrgContext must be used inside an organization route');
  return v;
}
