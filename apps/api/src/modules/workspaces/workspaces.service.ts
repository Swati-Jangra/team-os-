import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { MemberRole } from '@teamos/database';
import { ROLE_RANK, type RoleName } from '@teamos/permissions';
import { AppError, randomToken, slugify } from '@teamos/shared';
import type {
  AddWorkspaceMemberInput,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
} from '@teamos/validation';
import type { RequestActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';

export interface WorkspaceDto {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  settings: Record<string, unknown>;
  createdAt: Date;
}

const COLS = ['id', 'organizationId', 'name', 'slug', 'description', 'settings', 'createdAt'] as const;
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  private ctx(actor: RequestActor, workspaceId?: string) {
    return { userId: actor.userId, orgId: actor.orgId, workspaceId };
  }

  async create(actor: RequestActor, input: CreateWorkspaceInput): Promise<WorkspaceDto> {
    const explicit = input.slug !== undefined;
    const base = input.slug ?? (slugify(input.name) || 'workspace');

    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base.slice(0, 40)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
      const id = randomUUID();
      try {
        return await this.dbs.run(this.ctx(actor, id), async (trx) => {
          await trx
            .insertInto('workspaces')
            .values({
              id,
              organizationId: actor.orgId,
              name: input.name,
              slug,
              description: input.description ?? null,
              createdBy: actor.userId,
            })
            .execute();
          // creator becomes a member (visibility for non-admin creators; admins see all anyway)
          await trx
            .insertInto('workspaceMembers')
            .values({ organizationId: actor.orgId, workspaceId: id, userId: actor.userId, role: actor.role })
            .execute();
          await this.audit.record(trx, {
            ...this.audit.forActor(actor, {
              workspaceId: id,
              action: 'workspace.created',
              targetType: 'workspace',
              targetId: id,
              metadata: { name: input.name, slug },
            }),
          });
          await this.outbox.enqueue(
            trx,
            'workspace.created.v1',
            { organizationId: actor.orgId, workspaceId: id, name: input.name, createdByUserId: actor.userId },
            { orgId: actor.orgId, workspaceId: id },
          );
          return trx.selectFrom('workspaces').select(COLS).where('id', '=', id).executeTakeFirstOrThrow();
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (explicit) throw new AppError('SLUG_TAKEN');
      }
    }
    throw new AppError('SLUG_TAKEN');
  }

  /** RLS narrows this to the workspaces the caller may see (all for org OWNER/ADMIN, else memberships). */
  async list(actor: RequestActor): Promise<WorkspaceDto[]> {
    return this.dbs.run(this.ctx(actor), (trx) =>
      trx.selectFrom('workspaces').select(COLS).where('deletedAt', 'is', null).orderBy('name').execute(),
    );
  }

  async get(actor: RequestActor, workspaceId: string): Promise<WorkspaceDto> {
    const ws = await this.dbs.run(this.ctx(actor, workspaceId), (trx) =>
      trx.selectFrom('workspaces').select(COLS).where('id', '=', workspaceId).where('deletedAt', 'is', null).executeTakeFirst(),
    );
    if (!ws) throw new AppError('NOT_FOUND');
    return ws;
  }

  async update(actor: RequestActor, workspaceId: string, input: UpdateWorkspaceInput): Promise<WorkspaceDto> {
    return this.dbs.run(this.ctx(actor, workspaceId), async (trx) => {
      const patch: { name?: string; description?: string | null; settings?: string; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.settings !== undefined) patch.settings = JSON.stringify(input.settings);
      const ws = await trx
        .updateTable('workspaces')
        .set(patch)
        .where('id', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .returning(COLS)
        .executeTakeFirst();
      if (!ws) throw new AppError('NOT_FOUND');
      await this.audit.record(
        trx,
        this.audit.forActor(actor, {
          workspaceId,
          action: 'workspace.updated',
          targetType: 'workspace',
          targetId: workspaceId,
          metadata: { fields: Object.keys(input) },
        }),
      );
      return ws;
    });
  }

  async remove(actor: RequestActor, workspaceId: string): Promise<void> {
    await this.dbs.run(this.ctx(actor, workspaceId), async (trx) => {
      const r = await trx
        .updateTable('workspaces')
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where('id', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new AppError('NOT_FOUND');
      await this.audit.record(
        trx,
        this.audit.forActor(actor, {
          workspaceId,
          action: 'workspace.deleted',
          targetType: 'workspace',
          targetId: workspaceId,
        }),
      );
    });
  }

  async listMembers(actor: RequestActor, workspaceId: string) {
    return this.dbs.run(this.ctx(actor, workspaceId), async (trx) => {
      const ws = await trx
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!ws) throw new AppError('NOT_FOUND');
      return trx
        .selectFrom('workspaceMembers as wm')
        .innerJoin('users as u', 'u.id', 'wm.userId')
        .select(['wm.userId', 'u.name', 'u.email', 'wm.role', 'wm.createdAt'])
        .where('wm.workspaceId', '=', workspaceId)
        .where('wm.deletedAt', 'is', null)
        .orderBy('u.name')
        .execute();
    });
  }

  async addMember(actor: RequestActor, workspaceId: string, input: AddWorkspaceMemberInput) {
    if (ROLE_RANK[input.role as RoleName] > ROLE_RANK[actor.role] || (input.role === 'OWNER' && actor.role !== 'OWNER')) {
      throw new AppError('FORBIDDEN');
    }
    return this.dbs.run(this.ctx(actor, workspaceId), async (trx) => {
      const ws = await trx
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!ws) throw new AppError('NOT_FOUND');

      const orgMember = await trx
        .selectFrom('organizationMembers')
        .select('userId')
        .where('organizationId', '=', actor.orgId)
        .where('userId', '=', input.userId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!orgMember) throw new AppError('NOT_FOUND', 'User is not a member of this organization');

      await trx
        .insertInto('workspaceMembers')
        .values({ organizationId: actor.orgId, workspaceId, userId: input.userId, role: input.role as MemberRole })
        .onConflict((oc) =>
          oc.columns(['workspaceId', 'userId']).doUpdateSet({ role: input.role as MemberRole, deletedAt: null, updatedAt: new Date() }),
        )
        .execute();
      await this.audit.record(
        trx,
        this.audit.forActor(actor, {
          workspaceId,
          action: 'workspace.member_added',
          targetType: 'user',
          targetId: input.userId,
          metadata: { role: input.role },
        }),
      );
      return { userId: input.userId, role: input.role };
    });
  }

  async removeMember(actor: RequestActor, workspaceId: string, userId: string): Promise<void> {
    await this.dbs.run(this.ctx(actor, workspaceId), async (trx) => {
      const target = await trx
        .selectFrom('workspaceMembers')
        .select('role')
        .where('workspaceId', '=', workspaceId)
        .where('userId', '=', userId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!target) throw new AppError('NOT_FOUND');
      if (actor.role !== 'OWNER' && ROLE_RANK[target.role as RoleName] >= ROLE_RANK[actor.role]) {
        throw new AppError('FORBIDDEN');
      }
      await trx
        .updateTable('workspaceMembers')
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where('workspaceId', '=', workspaceId)
        .where('userId', '=', userId)
        .execute();
      await this.audit.record(
        trx,
        this.audit.forActor(actor, {
          workspaceId,
          action: 'workspace.member_removed',
          targetType: 'user',
          targetId: userId,
        }),
      );
    });
  }
}
