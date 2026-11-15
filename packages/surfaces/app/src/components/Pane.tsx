// Maintained tabs and panels hold existing tool/file owners. Editors and the single Files
// browser stay mounted through view changes; presentation never authorises or stops work.
import type { MaterialEntry, PaneTab } from '@backbone-next/platform';
import { Diff, Folder, FolderTree, Globe, MessageSquareText, MoreHorizontal, Plus, SquareTerminal, X } from 'lucide-react';
import * as React from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { call, isMac } from '../lib/api';
import { shortcutFor } from '../lib/keys';
import { tabId, useApp, useLive, type TabKind } from '../lib/state';
import { cn } from '../lib/utils';
import { FileIcon } from './files/kind';
import { ChangesTab, VersionChanges } from './tabs/ChangesTab';
import { BrowserTab } from './tabs/BrowserTab';
import { FileTab } from './tabs/FileTab';
import { FilesTab } from './tabs/FilesTab';
import { SideChatTab } from './tabs/SideChatTab';
import { TerminalTab } from './tabs/TerminalTab';
import { Button } from './ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { ClosableTab, TabStrip, Tabs, TabsContent } from './ui/tabs';

const TOOLS: { kind: Exclude<TabKind, 'file' | 'diff' | 'launcher'>; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { kind: 'browser', label: 'Browser', icon: Globe },
  { kind: 'changes', label: 'Changes', icon: Diff },
  { kind: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { kind: 'files', label: 'Files', icon: Folder },
  { kind: 'side-chat', label: 'Side chat', icon: MessageSquareText },
];

/** After a control disappears, keep the keyboard somewhere useful: the first of these that exists once the change has rendered. */
function focusLater(...selectors: string[]) {
  setTimeout(() => selectors.map((s) => document.querySelector<HTMLElement>(s)).find(Boolean)?.focus());
}

export function Pane({ projectId, threadId }: { projectId?: string; threadId?: string }) {
  const { prefs, setPrefs, closeTab, setPaneOpen, openTab } = useApp();
  const tabs = prefs.pane.tabs;
  const [pageTitle, setPageTitle] = React.useState('Browser');
  const fileIds = [...new Set(tabs.flatMap((t) => t.kind === 'file' || t.kind === 'diff' ? [t.materialId] : []))];
  const material = useLive(async () => (await Promise.all(fileIds.map((id) => call('material.read', { id })))).flatMap((r) => r.ok ? [r.value.entry] : []), [fileIds.join(',')], [] as MaterialEntry[]);
  const active = tabs.find((t) => t.id === prefs.pane.active) ?? tabs[0];
  const realTabs = tabs.filter((tab) => tab.kind !== 'launcher');
  const nameOf = (id: string) => material.find((m) => m.id === id)?.name;
  const label = (t: PaneTab) => t.kind === 'file' ? `${nameOf(t.materialId) ?? 'File'}${t.version === undefined ? '' : ` · v${t.version}`}` : t.kind === 'diff' ? `${nameOf(t.materialId) ?? 'File'} · v${t.version} changes` : t.kind === 'browser' ? pageTitle : t.kind === 'launcher' ? 'New tab' : TOOLS.find((x) => x.kind === t.kind)?.label ?? t.kind;
  // What a narrow tab cannot show: a document's version, and work still going on in a view. Closing a tab cancels neither.
  const [pageLoading, setPageLoading] = React.useState(false);
  React.useEffect(() => window.backbone?.onBrowserState?.((state) => setPageLoading(state.phase === 'loading')), []);
  const [terminalBusy, setTerminalBusy] = React.useState(false);
  const currentOf = (id: string) => material.find((m) => m.id === id)?.current;
  const detail = (t: PaneTab) => t.kind === 'file' ? (t.version === undefined && currentOf(t.materialId) !== undefined ? `v${currentOf(t.materialId)}` : undefined) : t.kind === 'browser' && pageLoading ? 'loading' : t.kind === 'terminal' && terminalBusy ? 'running' : undefined;
  const help = (t: PaneTab) => [label(t), detail(t)].filter(Boolean).join(' · ');
  const closeTabs = (keep?: string) => {
    for (const tab of realTabs) if (tab.id !== keep) closeTab(tab.id);
    focusLater('[data-testid=pane] [role=tab][aria-selected=true]', '[data-pane-toggle]');
  };
  const iconOf = (tab: PaneTab) => {
    if (tab.kind === 'file') return <FileIcon name={label(tab)} />;
    const Icon = tab.kind === 'diff' ? Diff : TOOLS.find((t) => t.kind === tab.kind)?.icon ?? Plus;
    return <Icon className="size-4 text-muted" aria-hidden />;
  };
  const openLauncher = () => setPrefs((p) => ({ ...p, pane: { open: true, tabs: p.pane.tabs.some((t) => t.id === 'launcher') ? p.pane.tabs : [...p.pane.tabs, { id: 'launcher', kind: 'launcher' }], active: 'launcher' } }));
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const groupElement = React.useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = React.useState(0);
  React.useEffect(() => {
    const element = groupElement.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const reader = usePanelRef();
  const browser = usePanelRef();
  const filesView = active?.kind === 'files';
  const besideFile = active?.kind === 'file' && browserOpen && availableWidth >= 500;
  React.useLayoutEffect(() => {
    if (!availableWidth || !prefs.pane.open) return;
    if (filesView) {
      setBrowserOpen(true);
      reader.current?.collapse();
      browser.current?.expand();
    } else {
      // A collapsed panel cannot grow into space another still holds, so the reader takes it outright.
      reader.current?.resize('100%');
      if (besideFile) browser.current?.resize('240px');
      else browser.current?.collapse();
    }
  }, [filesView, besideFile, projectId, prefs.pane.open, availableWidth, reader, browser]);
  return (
    <aside aria-label="Side pane" data-workspace data-tab-scope data-testid="pane" className={cn('fixed inset-0 z-50 flex flex-col bg-surface lg:static lg:z-auto lg:h-full lg:w-full', !prefs.pane.open && 'hidden')}>
      <Tabs value={active?.id ?? ''} onValueChange={(id) => setPrefs((p) => ({ ...p, pane: { ...p.pane, active: id } }))} activationMode="manual" className="flex h-full min-h-0 flex-col">
        <div data-workspace-bar data-testid="workspace-bar" className="app-window-bar flex h-[42px] min-w-0 shrink-0 items-center gap-1 border-b border-border bg-bg px-2">
          <TabStrip label="Pane tabs" value={active?.id} tabs={realTabs.map((tab) => ({ value: tab.id, label: label(tab), detail: detail(tab), icon: iconOf(tab) }))} onChoose={(id) => setPrefs((p) => ({ ...p, pane: { ...p.pane, active: id } }))}>
            {realTabs.map((tab) => (
              <ClosableTab key={tab.id} value={tab.id} title={help(tab)} active={tab.id === active?.id} closeLabel={`Close ${label(tab)}`} onClose={() => { closeTab(tab.id); focusLater('[data-testid=pane] [role=tab][aria-selected=true]', '[data-testid=pane] [aria-label="New tab"]', '[data-pane-toggle]'); }}>
                {iconOf(tab)}<span className="truncate">{label(tab)}</span>
              </ClosableTab>
            ))}
          </TabStrip>
          {/* New tab sits after the tabs; then the pane's menu and Close pane. A document's own actions are in its header. The space between moves the window. */}
          {realTabs.length > 0 ? <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="New tab" tip onClick={openLauncher}><Plus /></Button> : <Button variant="outline" size="sm" className="shrink-0" onClick={openLauncher}>Open…</Button>}
          <div className="min-w-0 flex-1" />
          <div role="group" aria-label="Pane controls" className="flex shrink-0 items-center gap-1">
            {realTabs.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Pane options" tip><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent data-workspace align="end">
                  <DropdownMenuItem disabled={realTabs.length < 2 || !active || active.kind === 'launcher'} onSelect={() => closeTabs(active?.id)}>Close other tabs</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => closeTabs()}>Close all tabs</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="ghost" size="icon-sm" aria-label="Close pane" tip onClick={() => { setPaneOpen(false); focusLater('[data-pane-toggle]'); }}><X /></Button>
          </div>
        </div>
        <Group elementRef={groupElement} className="min-h-0 flex-1" onLayoutChanged={(sizes, meta) => { if (meta.isUserInteraction && active?.kind === 'file') setBrowserOpen(sizes['workspace-browser'] > 0); }}>
          <Panel id="workspace-reader" panelRef={reader} minSize="220px" defaultSize="100%" collapsible collapsedSize="0px" className="h-full min-w-0">
            {!projectId ? <p className="p-4 text-sm text-muted">Choose a project to see its files and tools.</p> : (
              <>
                {prefs.pane.open && active?.kind === 'launcher' && <section aria-label="Open a file or tool" className="h-full"><Launcher /></section>}
                {tabs.filter((tab) => tab.kind !== 'files' && tab.kind !== 'launcher').map((tab) => (
                  <TabsContent key={tab.id} value={tab.id} forceMount className="h-full data-[state=inactive]:hidden">
                    {tab.kind === 'browser' ? <BrowserTab active={prefs.pane.open && active?.id === tab.id} onTitle={setPageTitle} /> : tab.kind === 'file' ? <FileTab key={tab.id} materialId={tab.materialId} version={tab.version} active={active?.id === tab.id} extra={active?.id === tab.id && <Button variant="ghost" size="icon-sm" aria-label="Browse files" tip aria-pressed={besideFile} onClick={() => availableWidth < 500 ? openTab('files') : setBrowserOpen((open) => !open)}><FolderTree /></Button>} onSaved={() => {
                      if (tab.version === undefined) return;
                      setPrefs((current) => {
                        if (current.pane.active !== tab.id || !current.pane.tabs.some((x) => x.id === tab.id)) return current;
                        const id = tabId('file', tab.materialId);
                        const tabs = current.pane.tabs.filter((x) => x.id !== tab.id);
                        if (!tabs.some((x) => x.id === id)) tabs.push({ id, kind: 'file', materialId: tab.materialId });
                        return { ...current, pane: { ...current.pane, tabs, active: id } };
                      });
                    }} /> : tab.kind === 'diff' ? <VersionChanges projectId={projectId} materialId={tab.materialId} version={tab.version} name={nameOf(tab.materialId)} /> : tab.kind === 'changes' ? <ChangesTab projectId={projectId} threadId={threadId} /> : tab.kind === 'terminal' ? <TerminalTab key={projectId} projectId={projectId} active={prefs.pane.open && active?.id === tab.id} onBusy={setTerminalBusy} /> : threadId ? <SideChatTab threadId={threadId} /> : <p className="p-4 text-sm text-muted">Open a thread to start a side chat.</p>}
                  </TabsContent>
                ))}
              </>
            )}
          </Panel>
          {besideFile && <Separator aria-label="Resize file browser" className="w-px bg-border hover:bg-muted focus-visible:bg-ring" />}
          <Panel id="workspace-browser" panelRef={browser} minSize="180px" defaultSize="0px" collapsible collapsedSize="0px" className="h-full min-w-0 bg-bg">
            {projectId && <TabsContent value="files" forceMount role={filesView ? 'tabpanel' : 'region'} aria-label="Files" hidden={!filesView && !besideFile} inert={!filesView && !besideFile} className="h-full"><FilesTab key={projectId} projectId={projectId} compact={!filesView} active={prefs.pane.open && filesView} /></TabsContent>}
          </Panel>
        </Group>
      </Tabs>
    </aside>
  );
}

function Launcher() {
  const { openTab, closeTab } = useApp();
  const mac = isMac();
  return (
    <Command className="p-2" label="New tab">
      <CommandInput placeholder="Open a tool…" autoFocus />
      <CommandList><CommandGroup heading="Tools">{TOOLS.map((tool) => <CommandItem key={tool.label} onSelect={() => { closeTab('launcher'); openTab(tool.kind); }}><tool.icon className="text-muted" />{tool.label}<span className="ml-auto text-xs text-muted">{shortcutFor(tool.kind, mac)}</span></CommandItem>)}</CommandGroup></CommandList>
    </Command>
  );
}
