import { Tabs as T } from 'radix-ui';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';

export const Tabs = T.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof T.List>) {
  return <T.List className={cn('flex items-center gap-0.5', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted hover:text-fg data-[state=active]:bg-hover data-[state=active]:text-fg [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  );
}

/** A tab that closes: a pill with its close beside it, shown on the active tab and on hover. */
export function ClosableTab({ value, title, active, closeLabel, onClose, children }: { value: string; title: string; active: boolean; closeLabel: string; onClose(): void; children: React.ReactNode }) {
  // The active tab stays in view when the strip overflows: opening a file adds a tab at the far end.
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { if (active) ref.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [active]);
  return (
    <div ref={ref} className={cn('group flex shrink-0 items-center rounded-md', active && 'bg-hover')}>
      <TabsTrigger value={value} title={title} className="h-8 max-w-40 px-2 text-ui font-normal xl:max-w-56">{children}</TabsTrigger>
      <Button variant="ghost" size="icon-sm" className={cn(!active && 'reveal')} aria-label={closeLabel} title={closeLabel} onClick={onClose}><X /></Button>
    </div>
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof T.Content>) {
  return <T.Content className={cn('min-h-0 flex-1 outline-none', className)} {...props} />;
}
