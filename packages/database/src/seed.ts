import { PERMISSIONS, ROLES, permissionsFor } from '@teamos/permissions';
import type { Database } from './client';

/**
 * Mirrors the code-defined permission matrix into the roles/permissions catalog tables.
 * Idempotent. Must run as the schema owner (app_user only has SELECT on these tables).
 */
export async function seedSystemRoles(db: Database): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const key of PERMISSIONS) {
      await trx
        .insertInto('permissions')
        .values({ key, description: null })
        .onConflict((oc) => oc.column('key').doNothing())
        .execute();
    }
    for (const name of ROLES) {
      await trx
        .insertInto('roles')
        .values({ name, organizationId: null, description: null, isSystem: true })
        .onConflict((oc) => oc.column('name').where('organizationId', 'is', null).doNothing())
        .execute();
    }

    const roles = await trx.selectFrom('roles').select(['id', 'name']).where('organizationId', 'is', null).execute();
    const perms = await trx.selectFrom('permissions').select(['id', 'key']).execute();
    const permId = new Map(perms.map((p) => [p.key as string, p.id]));

    await trx
      .deleteFrom('rolePermissions')
      .where(
        'roleId',
        'in',
        roles.map((r) => r.id),
      )
      .execute();

    for (const role of roles) {
      const granted = permissionsFor(role.name as (typeof ROLES)[number]);
      if (granted.length === 0) continue;
      await trx
        .insertInto('rolePermissions')
        .values(granted.map((p) => ({ roleId: role.id, permissionId: permId.get(p)! })))
        .execute();
    }
  });
}
