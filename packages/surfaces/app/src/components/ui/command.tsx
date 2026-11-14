import { Command as C } from 'cmdk';
import { Search } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/utils';

export function Command({ className, ...props }: React.ComponentProps<typeof C>) {
  return <C className={cn('flex h-full w-full flex-col overflow-hidden text-fg', className)} {...props} />;
}

export function CommandInput({ className, ...props }: React.ComponentProps<typeof C.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Search className="size-4 text-muted" aria-hidden />
      <C.Input className={cn('h-9 w-full bg-transparent text-sm outline-none focus-visible:outline-none placeholder:text-muted', className)} {...props} />
    </div>
  );
}

export function CommandList({ className, ...props }: React.ComponentProps<typeof C.List>) {
  return <C.List className={cn('min-h-0 flex-1 overflow-y-auto p-1', className)} {...props} />;
}

export function CommandEmpty(props: React.ComponentProps<typeof C.Empty>) {
  return <C.Empty className="px-3 py-6 text-center text-sm text-muted" {...props} />;
}

export function CommandGroup({ className, ...props }: React.ComponentProps<typeof C.Group>) {
  return <C.Group className={cn('[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted', className)} {...props} />;
}

export function CommandItem({ className, ...props }: React.ComponentProps<typeof C.Item>) {
  return (
    <C.Item
      className={cn('flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-hover data-[disabled=true]:opacity-50 [&_svg]:size-4', className)}
      {...props}
    />
  );
}
