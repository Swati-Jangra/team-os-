import * as React from 'react';
import { cn } from '../cn';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-card text-card-foreground shadow-card', className)}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  title,
  description,
  action,
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 p-5 pb-3', className)} {...props}>
      <div className="min-w-0 space-y-1">
        {title ? <h3 className="text-base font-semibold leading-tight tracking-tight">{title}</h3> : null}
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-2', className)} {...props} />;
}
