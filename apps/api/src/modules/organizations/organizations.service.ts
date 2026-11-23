import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { MemberRole } from '@teamos/database';
import { AppError, randomToken, slugify } from '@teamos/shared';
import type { CreateOrganizationInput, UpdateOrganizationInput } from '@teamos/validation';
import type { RequestActor, UserActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  createdAt: Date;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async create(user: UserActor, input: CreateOrganizationInput): Promise<OrganizationDto & { role: MemberRole }> {
    const explicit = input.slug !== undefined;
    const base = input.slug ?? (slugify(input.name) || 'org');

    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base.slice(0, 40)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
      const id = randomUUID();
      try {
        return await this.dbs.run({ userId: user.userId, orgId: id }, async (trx) => {
          const org = await trx
            .insertInto('organizations')
            .values({ id, name: input.name, slug, createdBy: user.userId })
            .execute()
            .then(() => ({ id, name: input.name, slug, settings: {} as Record<string, unknown>, createdAt: new Date() }));
          await trx
            .insertInto('organizationMembers')
            .values({ organizationId: id, userId: user.userId, role: 'OWNER' })
            .execute();
          await this.audit.record(trx, {
            actorType: 'USER',
            actorId: user.userId,
            orgId: id,
            action: 'org.created',
            targetType: 'organization',
            targetId: id,
            metadata: { name: input.name, slug },
            requestId: user.requestId,
            ip: user.ip,
          });
          await this.outbox.enqueue(
            trx,
            'org.created.v1',
            { organizationId: id, name: input.name, ownerUserId: user.userId },
            { orgId: id },
          );
          return { ...org, role: 'OWNER' as const };
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (explicit) throw new AppError('SLUG_TAKEN');
      }
    }
    throw new AppError('SLUG_TAKEN');
  }

  async listForUser(userId: string): Promise<Array<OrganizationDto & { role: MemberRole }>> {
    return this.dbs.run({ userId }, (trx) =>
      trx
        .selectFrom('organizationMembers as m')
        .innerJoin('organizations as o', 'o.id', 'm.organizationId')
        .select(['o.id', 'o.name', 'o.slug', 'o.settings', 'o.createdAt', 'm.role'])
        .where('m.userId', '=', userId)
        .where('m.deletedAt', 'is', null)
        .where('o.deletedAt', 'is', null)
        .orderBy('o.name')
        .execute(),
    );
  }

  async get(actor: RequestActor): Promise<OrganizationDto & { role: MemberRole }> {
    const org = await this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, (trx) =>
      trx
        .selectFrom('organizations')
        .select(['id', 'name', 'slug', 'settings', 'createdAt'])
        .where('id', '=', actor.orgId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst(),
    );
    if (!org) throw new AppError('NOT_FOUND');
    return { ...org, role: actor.role };
  }

  async update(actor: RequestActor, input: UpdateOrganizationInput): Promise<OrganizationDto> {
    return this.dbs.run({ userId: actor.userId, orgId: actor.orgId }, async (trx) => {
      const patch: { name?: string; settings?: string; updatedAt: Date } = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.settings !== undefined) patch.settings = JSON.stringify(input.settings);
      const org = await trx
        .updateTable('organizations')
        .set(patch)
        .where('id', '=', actor.orgId)
        .where('deletedAt', 'is', null)
        .returning(['id', 'name', 'slug', 'settings', 'createdAt'])
        .executeTakeFirst();
      if (!org) throw new AppError('NOT_FOUND');
      await this.audit.record(
        trx,
        this.audit.forActor(actor, {
          action: 'org.updated',
          targetType: 'organization',
          targetId: actor.orgId,
          metadata: { fields: Object.keys(input) },
        }),
      );
      return org;
    });
  }
}
