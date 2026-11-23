'use client';
import { Fragment } from 'react';
import { Check, Minus } from 'lucide-react';
import { PERMISSIONS, ROLES, hasPermission, type Permission } from '@teamos/permissions';
import { Badge, Card, CardContent, CardHeader } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useOrgContext } from '@/features/org/org-context';
import { ROLE_LABEL } from '@/lib/labels';

const GROUP_LABEL: Record<string, string> = {
  org: 'Organization',
  member: 'Members',
  role: 'Roles',
  workspace: 'Workspaces',
  team: 'Teams',
  audit: 'Audit',
  project: 'Projects',
  task: 'Tasks',
  comment: 'Comments',
  meeting: 'Meetings',
  document: 'Documents',
  ai: 'AI',
  approval: 'Approvals',
  integration: 'Integrations',
};

/** Page 30 — Role and Permission Management. Read-only in Phase 1: roles are defined in code and enforced by the API. */
export default function RolesPage() {
  const { role: myRole } = useOrgContext();
  const groups = new Map<string, Permission[]>();
  for (const p of PERMISSIONS) {
    const g = p.split(':')[0]!;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="What each role can do. Permissions are enforced on the server for every request."
        actions={<Badge tone="primary">Your role: {ROLE_LABEL[myRole]}</Badge>}
      />
      <Card>
        <CardHeader
          title="Permission matrix"
          description="Custom roles are not editable yet — the seven system roles below apply to every organization."
        />
        <CardContent className="overflow-x-auto p-0 pb-2">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="sticky left-0 bg-card pb-2 pl-5 pr-3 font-medium">
                  Permission
                </th>
                {ROLES.map((r) => (
                  <th key={r} scope="col" className={`px-2 pb-2 text-center font-medium ${r === myRole ? 'text-primary' : ''}`}>
                    {ROLE_LABEL[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...groups.entries()].map(([group, perms]) => (
                <Fragment key={group}>
                  <tr className="bg-muted/60">
                    <th scope="rowgroup" colSpan={ROLES.length + 1} className="px-5 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {GROUP_LABEL[group] ?? group}
                    </th>
                  </tr>
                  {perms.map((p) => (
                    <tr key={p} className="border-t border-border">
                      <th scope="row" className="sticky left-0 bg-card py-2 pl-5 pr-3 text-left font-mono text-xs font-normal">
                        {p}
                      </th>
                      {ROLES.map((r) => (
                        <td key={r} className="px-2 py-2 text-center">
                          {hasPermission(r, p) ? (
                            <Check className="mx-auto h-4 w-4 text-success" aria-label="Allowed" />
                          ) : (
                            <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" aria-label="Not allowed" />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}
