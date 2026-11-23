'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import { forgotPasswordSchema, type ForgotPasswordInput } from '@teamos/validation';
import { Button, Field, Input } from '@teamos/ui';
import { api, ApiError } from '@/lib/api';
import { AuthShell, FormError } from '@/features/auth/auth-shell';

export default function ForgotPasswordPage() {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: values });
      setSent(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
  });

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we’ll send you a reset link."
      footer={
        <Link href="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/50 p-6 text-center" role="status">
          <MailCheck className="h-8 w-8 text-primary" aria-hidden />
          <p className="text-sm text-muted-foreground">
            If an account exists for that address, a reset link is on its way. The link expires in one hour.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormError message={error} />
          <Field label="Email" htmlFor="email" error={errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} />
          </Field>
          <Button type="submit" className="w-full" loading={isSubmitting}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
