import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/utils';

/** Draft, pending and committed never look alike (R-UX-DRAFT-01). */
export const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium [&_svg]:size-3', {
  variants: {
    tone: {
      neutral: 'bg-sunken text-muted',
      draft: 'border border-dashed border-draft bg-draft-bg text-draft',
      pending: 'bg-pending-bg text-pending',
      committed: 'bg-committed-bg text-committed',
      danger: 'bg-sunken text-danger',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
