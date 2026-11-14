import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../../lib/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-fg text-bg hover:opacity-90 active:opacity-80',
        ghost: 'text-fg hover:bg-hover active:bg-sunken',
        outline: 'border border-border bg-surface text-fg hover:bg-hover active:bg-sunken',
        subtle: 'bg-sunken text-fg hover:bg-hover active:bg-border',
      },
      size: { default: 'h-8 px-3', sm: 'h-7 px-2 text-xs', icon: 'size-8', 'icon-sm': 'size-7' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({ className, variant, size, asChild, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
