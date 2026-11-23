'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import { registerSchema, type RegisterInput } from '@teamos/validation';
import { Button, Field, Input } from '@teamos/ui';
import { api, ApiError, applyFieldErrors } from '@/lib/api';
import { AuthShell, FormError } from '@/features/auth/auth-shell';

export default function RegisterPage() {
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/register', { method: 'POST', body: values });
      setSentTo(values.email);
    } catch (e) {
      if (!applyFieldErrors(e, setFieldError as never, ['email', 'name', 'password'])) {
        setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
      }
    }
  });

  if (sentTo) {
    return (
      <AuthShell title="Check your email" subtitle={`We sent a verification link to ${sentTo}.`}>
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/50 p-6 text-center">
          <MailCheck className="h-8 w-8 text-primary" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Click the link in the email to activate your account. If you already have an account with this
            address, sign in instead.
          </p>
        </div>
        <Link href="/login" className="block text-center text-sm font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Start organizing your team’s work in minutes."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Full name" htmlFor="name" error={errors.name?.message}>
          <Input id="name" autoComplete="name" aria-invalid={!!errors.name} {...register('name')} />
        </Field>
        <Field label="Work email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          error={errors.password?.message}
          hint="At least 10 characters, with letters and numbers."
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.password}
            {...register('password')}
          />
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
