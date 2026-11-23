'use client';
import * as React from 'react';
import * as Dd from '@radix-ui/react-dropdown-menu';
import { cn } from '../cn';

export const DropdownMenu = Dd.Root;
export const DropdownMenuTrigger = Dd.Trigger;
export const DropdownMenuLabel = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof Dd.Label>) => (
  <Dd.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...p} />
);
export const DropdownMenuSeparator = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof Dd.Separator>) => (
  <Dd.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...p} />
);

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentPropsWithoutRef<typeof Dd.Content>) {
  return (
    <Dd.Portal>
      <Dd.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[12rem] overflow-hidden rounded-xl border border-border bg-card p-1 text-card-foreground shadow-pop',
          className,
        )}
        {...props}
      />
    </Dd.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: React.ComponentPropsWithoutRef<typeof Dd.Item> & { destructive?: boolean }) {
  return (
    <Dd.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted',
        destructive && 'text-destructive',
        className,
      )}
      {...props}
    />
  );
}
