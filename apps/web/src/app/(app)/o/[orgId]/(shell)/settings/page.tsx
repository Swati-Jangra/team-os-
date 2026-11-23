'use client';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { updateOrganizationSchema, type UpdateOrganizationInput } from '@teamos/validation';
import { Button, Card, CardContent, CardHeader, ErrorState, Field, Input, Skeleton } from '@teamos/ui';
import { PageHeader } from '@/components/page';
import { useOrg, useOrgMutations } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { formatDate } from '@/lib/labels';

/** Page 28 — Organization Settings. */
export default function OrganizationSettingsPage() {
  const { orgId, can } = useOrgContext();
  const org = useOrg(orgId);
  const { updateOrg } = useOrgMutations(orgId);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<UpdateOrganizationInput>({ resolver: zodResolver(updateOrganizationSchema) });

  useEffect(() => {
    if (org.data) reset({ name: org.data.name });
  }, [org.data, reset]);

  return (
    <>
      <PageHeader title="Organization settings" description="Manage your organization’s details." />
      <Card className="max-w-2xl">
        <CardHeader title="General" />
        <CardContent>
          {org.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : org.isError ? (
            <ErrorState message="Couldn't load the organization." onRetry={() => org.refetch()} />
          ) : (
            <form
              onSubmit={handleSubmit((v) => updateOrg.mutate({ name: v.name! }))}
              className="space-y-4"
              noValidate
            >
              <Field label="Organization name" htmlFor="name" error={errors.name?.message}>
                <Input id="name" disabled={!can('org:update')} {...register('name')} />
              </Field>
              <Field label="URL name" htmlFor="slug" hint="Used in links. It can’t be changed.">
                <Input id="slug" value={org.data.slug} readOnly disabled />
              </Field>
              <p className="text-sm text-muted-foreground">Created {formatDate(org.data.createdAt)}</p>
              {can('org:update') ? (
                <Button type="submit" disabled={!isDirty} loading={updateOrg.isPending}>
                  Save changes
                </Button>
              ) : null}
            </form>
          )}
        </CardContent>
      </Card>
    </>
  );
}
