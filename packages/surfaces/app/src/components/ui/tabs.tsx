import { Tabs as T } from 'radix-ui';
import { ChevronDown, X } from 'lucide-react';
import * as React from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './command';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export const Tabs = T.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof T.List>) {
  return <T.List className={cn('flex items-center gap-0.5', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium text-muted hover:text-fg data-[state=active]:bg-hover data-[state=active]:text-fg [&_svg]:size-3.5 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

/** One tab as the list of all tabs shows it: `detail` is what the narrow tab cannot show (a version, "running"). */
/** Scrolls the row just enough to show the whole tab, its close button included. */
function reveal(strip: HTMLElement, tab: Element | null) {
  const whole = tab?.closest<HTMLElement>('[data-strip-tab]') ?? tab;
  if (!whole) return;
  const box = whole.getBoundingClientRect();
  const view = strip.getBoundingClientRect();
  if (box.left < view.left) strip.scrollLeft -= view.left - box.left;
  else if (box.right > view.right) strip.scrollLeft += Math.min(box.right - view.right, box.left - view.left);
}

export interface StripTab { value: string; label: string; detail?: string; icon?: React.ReactNode }

/**
 * A row of tabs that holds any number of them, after editor tab rows (VS Code) and Chrome's shrinking
 * tabs. Labels stay on one line; tabs shrink towards a minimum and then the row scrolls sideways (the
 * wheel scrolls it too), with the active tab kept wholly in view whenever it changes or the row is
 * resized. When some tabs are out of view, "Show all tabs" lists every tab with a search field. The
 * arrow keys move between tabs, as in any tab list; Ctrl+Tab goes to the tab used before, anywhere
 * inside the nearest `data-tab-scope`. The row is never wider than its tabs, so the bar's empty space
 * beside it still moves the window.
 */
export function TabStrip({ label, value, tabs, onChoose, className, children }: { label: string; value?: string; tabs: StripTab[]; onChoose(value: string): void; className?: string; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState(false);
  const [listing, setListing] = React.useState(false);
  const shape = tabs.map((tab) => `${tab.value}\u0000${tab.label}`).join('\u0001');
  React.useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const fit = () => {
      setOverflow(strip.scrollWidth > strip.clientWidth + 1);
      reveal(strip, strip.querySelector<HTMLElement>('[role=tab][data-state=active]'));
    };
    fit();
    // A hidden pane has no size: the row fits again when it is shown, and when a label grows (a page's title
    // arrives). The next frame, so that showing "Show all tabs" does not resize the row inside the callback.
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); });
    observer.observe(strip);
    for (const child of strip.children) observer.observe(child);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [value, shape]);

  // Most recently used first. While Control is held, Ctrl+Tab steps further back; letting go settles the order.
  const recent = React.useRef<string[]>([]);
  const stepping = React.useRef(-1);
  const present = tabs.map((tab) => tab.value);
  recent.current = [...recent.current.filter((v) => present.includes(v)), ...present.filter((v) => !recent.current.includes(v))];
  React.useEffect(() => {
    if (value && stepping.current < 0) recent.current = [value, ...recent.current.filter((v) => v !== value)];
  }, [value]);
  const choose = React.useRef(onChoose);
  choose.current = onChoose;
  React.useEffect(() => {
    const scope = ref.current?.closest<HTMLElement>('[data-tab-scope]');
    if (!scope) return;
    const down = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.key !== 'Tab' || recent.current.length < 2) return;
      event.preventDefault();
      const order = recent.current;
      stepping.current = (stepping.current < 0 ? 0 : stepping.current) + (event.shiftKey ? order.length - 1 : 1);
      const next = order[stepping.current % order.length];
      choose.current(next);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[role=tab][data-state=active]`)?.focus());
    };
    const up = (event: KeyboardEvent) => {
      if (event.key !== 'Control' || stepping.current < 0) return;
      const order = recent.current;
      const landed = order[stepping.current % order.length];
      stepping.current = -1;
      recent.current = [landed, ...order.filter((v) => v !== landed)];
    };
    const reset = () => { stepping.current = -1; };
    scope.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    return () => { scope.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', reset); };
  }, []);

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const strip = event.currentTarget;
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) strip.scrollLeft += event.deltaY;
  };
  return (
    <>
      <T.List ref={ref} aria-label={label} onWheel={onWheel} onFocus={(event) => reveal(event.currentTarget, event.target)} className={cn('flex min-w-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain [-webkit-app-region:no-drag] [scrollbar-width:none]', className)}>
        {children}
      </T.List>
      {(overflow || listing) && (
        <Popover open={listing} onOpenChange={setListing}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Show all tabs" tip><ChevronDown /></Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1rem)] p-0" onCloseAutoFocus={(event) => {
            // Back to the tab that was chosen, or the list button when nothing was.
            const active = ref.current?.querySelector<HTMLElement>('[role=tab][data-state=active]');
            if (active) { event.preventDefault(); active.focus(); }
          }}>
            {/* The search field is named by the list's label. */}
            <Command label="Find a tab" className="max-h-80">
              <CommandInput placeholder="Find a tab" autoFocus />
              <CommandList>
                <CommandEmpty>No tab matches.</CommandEmpty>
                {tabs.map((tab) => (
                  <CommandItem key={tab.value} value={`${tab.label} ${tab.detail ?? ''} ${tab.value}`} aria-current={tab.value === value ? 'true' : undefined} onSelect={() => { setListing(false); onChoose(tab.value); }} className={cn(tab.value === value && 'font-medium')}>
                    {tab.icon}<span className="min-w-0 truncate">{tab.label}</span>{tab.detail && <span className="ml-auto shrink-0 text-xs text-muted">{tab.detail}</span>}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

/**
 * A tab that closes. The active tab keeps its full label and its close button. Another tab shrinks
 * towards a minimum (its icon and a few letters) in a full row and shows its close button over the end
 * of its label on hover and keyboard focus. A middle click closes any tab. Closing a tab closes a view:
 * it never stops work.
 */
export function ClosableTab({ value, title, active, closeLabel, onClose, children }: { value: string; title: string; active: boolean; closeLabel: string; onClose(): void; children: React.ReactNode }) {
  return (
    <div
      data-strip-tab
      className={cn('group relative flex items-center rounded-md', active ? 'shrink-0 bg-hover' : 'min-w-[72px] shrink')}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(); } }}
    >
      <TabsTrigger value={value} title={title} className={cn('h-8 min-w-0 max-w-40 px-2 text-ui font-normal xl:max-w-56', !active && 'w-full')}>{children}</TabsTrigger>
      <Button variant="ghost" size="icon-sm" className={cn('shrink-0', !active && 'reveal absolute right-0.5 bg-bg')} aria-label={closeLabel} tip onClick={onClose}><X /></Button>
    </div>
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof T.Content>) {
  return <T.Content className={cn('min-h-0 flex-1 outline-none', className)} {...props} />;
}
