'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Layers } from 'lucide-react';
import { createWorkspaceSchema, type CreateWorkspaceInput } from '@teamos/validation';
import { Button, Card, CardContent, CardHeader, Field, Input, Textarea } from '@teamos/ui';
import { useOrgMutations } from '@/features/org/api';
import { useOrgContext } from '@/features/org/org-context';
import { FormError } from '@/features/auth/auth-shell';
import { ApiError } from '@/lib/api';

/** Page 5 — Workspace Setup. */
export default function WorkspaceSetupPage() {
  const { orgId, can, orgName } = useOrgContext();
  const router = useRouter();
  const { createWorkspace } = useOrgMutations(orgId);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateWorkspaceInput>({ resolver: zodResolver(createWorkspaceSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await createWorkspace.mutateAsync({ name: values.name, description: values.description || undefined });
      router.replace(`/o/${orgId}/dashboard`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader
          title="Create your first workspace"
          description={`Workspaces group projects and people inside ${orgName}. Think “Engineering” or “Marketing”.`}
        >
          <div className="mb-2 mt-1 w-fit rounded-xl bg-primary-soft p-3 text-primary">
            <Layers className="h-6 w-6" aria-hidden />
          </div>
        </CardHeader>
        <CardContent>
          {can('workspace:create') ? (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <FormError message={error} />
              <Field label="Workspace name" htmlFor="name" error={errors.name?.message}>
                <Input id="name" placeholder="Engineering" autoFocus aria-invalid={!!errors.name} {...register('name')} />
              </Field>
              <Field label="Description (optional)" htmlFor="description" error={errors.description?.message}>
                <Textarea id="description" rows={3} {...register('description')} />
              </Field>
              <Button type="submit" className="w-full" loading={createWorkspace.isPending}>
                Create workspace
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only owners and admins can create workspaces. Ask an admin to add you to one.
            </p>
          )}
          <div className="mt-4 text-center">
            <Link href={`/o/${orgId}/dashboard`} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
              Skip for now
            </Link>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
