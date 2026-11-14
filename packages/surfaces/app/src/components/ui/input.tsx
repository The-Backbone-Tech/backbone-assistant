import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/utils';

const field = cva(
  'rounded-md border border-strong-border bg-surface text-fg placeholder:text-muted focus-visible:outline-offset-0 disabled:text-muted',
  { variants: { size: { default: 'h-8 px-2 text-sm', sm: 'h-7 px-2 text-xs' } }, defaultVariants: { size: 'default' } },
);

export function Input({ className, size, ...props }: Omit<React.ComponentProps<'input'>, 'size'> & VariantProps<typeof field>) {
  return <input className={cn(field({ size }), 'w-full', className)} {...props} />;
}

/** A native select: the platform's own menu, keyboard and accessibility, in the shared field. */
export function Select({ className, size, ...props }: Omit<React.ComponentProps<'select'>, 'size'> & VariantProps<typeof field>) {
  return <select className={cn(field({ size }), className)} {...props} />;
}
