'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { createOrganizationSchema, type CreateOrganizationInput } from '@teamos/validation';
import { Button, Card, CardContent, CardHeader, Field, Input } from '@teamos/ui';
import { api, ApiError, applyFieldErrors } from '@/lib/api';
import { FormError } from '@/features/auth/auth-shell';

/** Page 4 — Organization Setup. */
export default function OrganizationSetupPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationInput>({ resolver: zodResolver(createOrganizationSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      const body = { name: values.name, ...(values.slug ? { slug: values.slug } : {}) };
      const org = await api<{ id: string }>('/organizations', { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace(`/o/${org.id}/onboarding/workspace`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SLUG_TAKEN') setFieldError('slug', { message: 'That URL name is taken' });
      else if (!applyFieldErrors(e, setFieldError as never, ['name', 'slug']))
        setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader
          title="Set up your organization"
          description="An organization is your company or team. You can create several workspaces inside it."
        >
          <div className="mb-2 mt-1 w-fit rounded-xl bg-primary-soft p-3 text-primary">
            <Building2 className="h-6 w-6" aria-hidden />
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <FormError message={error} />
            <Field label="Organization name" htmlFor="name" error={errors.name?.message}>
              <Input id="name" placeholder="Acme Inc." autoFocus aria-invalid={!!errors.name} {...register('name')} />
            </Field>
            <Field
              label="URL name (optional)"
              htmlFor="slug"
              error={errors.slug?.message}
              hint="Lowercase letters, numbers and hyphens. Generated from the name if left empty."
            >
              <Input id="slug" placeholder="acme" aria-invalid={!!errors.slug} {...register('slug', { setValueAs: (v) => (v === '' ? undefined : v) })} />
            </Field>
            <Button type="submit" className="w-full" loading={isSubmitting}>
              Create organization
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
