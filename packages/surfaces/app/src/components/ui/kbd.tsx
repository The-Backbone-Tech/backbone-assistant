import type * as React from 'react';
import { cn } from '../../lib/utils';

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return <kbd className={cn('ml-auto font-sans text-caption tracking-wider text-muted', className)} {...props} />;
}
