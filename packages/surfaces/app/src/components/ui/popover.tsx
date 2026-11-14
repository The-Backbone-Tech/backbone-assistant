import { Popover as P } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../../lib/utils';

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;

export function PopoverContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content sideOffset={sideOffset} collisionPadding={8} className={cn('z-50 w-72 rounded-lg border border-border bg-surface p-3 text-fg shadow-lg outline-none', className)} {...props} />
    </P.Portal>
  );
}
