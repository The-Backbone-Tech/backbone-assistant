import { Check, ChevronRight } from 'lucide-react';
import { ContextMenu as M } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../../lib/utils';
import { menuItem, menuPanel } from './dropdown-menu';

// The right-click menu: the same panel and item classes as the dropdown menu, so the two look alike.
export const ContextMenu = M.Root;
export const ContextMenuTrigger = M.Trigger;
export const ContextMenuSub = M.Sub;
export const ContextMenuRadioGroup = M.RadioGroup;

export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content collisionPadding={8} className={cn(menuPanel.context, className)} {...props} />
    </M.Portal>
  );
}

export function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof M.Item>) {
  return <M.Item className={cn(menuItem, className)} {...props} />;
}

export function ContextMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={cn(menuItem, 'pl-7', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <M.ItemIndicator>
          <Check />
        </M.ItemIndicator>
      </span>
      {children}
    </M.RadioItem>
  );
}

export function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof M.SubTrigger>) {
  return (
    <M.SubTrigger className={cn(menuItem, 'data-[state=open]:bg-hover', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </M.SubTrigger>
  );
}

export function ContextMenuSubContent({ className, ...props }: React.ComponentProps<typeof M.SubContent>) {
  return (
    <M.Portal>
      <M.SubContent collisionPadding={8} className={cn(menuPanel.context, className)} {...props} />
    </M.Portal>
  );
}

export function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof M.Label>) {
  return <M.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted', className)} {...props} />;
}

export function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
