'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { passwordSchema } from '@teamos/validation';
import { z } from 'zod';
import { Button, Field, Input, toast } from '@teamos/ui';
import { api, ApiError } from '@/lib/api';
import { AuthShell, FormError } from '@/features/auth/auth-shell';

const formSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type FormValues = z.infer<typeof formSchema>;

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  if (!token) {
    return (
      <AuthShell title="Link not valid" subtitle="This reset link is missing its token.">
        <Link href="/forgot-password" className="text-sm font-medium text-primary hover:underline">
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password: values.password } });
      toast.success('Password updated. Please sign in.');
      router.replace('/login');
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'TOKEN_INVALID'
          ? 'This reset link is invalid or has expired. Request a new one.'
          : e instanceof ApiError
            ? e.message
            : 'Something went wrong. Please try again.',
      );
    }
  });

  return (
    <AuthShell title="Choose a new password" subtitle="You’ll be signed out of all other devices.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="New password" htmlFor="password" error={errors.password?.message} hint="At least 10 characters, with letters and numbers.">
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register('password')} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm" error={errors.confirm?.message}>
          <Input id="confirm" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...register('confirm')} />
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
