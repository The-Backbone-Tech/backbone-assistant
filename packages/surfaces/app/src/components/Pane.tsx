// Maintained tabs and panels hold existing tool/file owners. Editors and the single Files
// browser stay mounted through view changes; presentation never authorises or stops work.
import type { MaterialEntry, PaneTab } from '@backbone-next/platform';
import { Diff, Folder, FolderTree, MessageSquareText, Plus, SquareTerminal, X } from 'lucide-react';
import * as React from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { call, isMac } from '../lib/api';
import { shortcutFor } from '../lib/keys';
import { tabId, useApp, useLive, type TabKind } from '../lib/state';
import { cn } from '../lib/utils';
import { FileIcon } from './files/kind';
import { ChangesTab, VersionChanges } from './tabs/ChangesTab';
import { FileTab } from './tabs/FileTab';
import { FilesTab } from './tabs/FilesTab';
import { SideChatTab } from './tabs/SideChatTab';
import { TerminalTab } from './tabs/TerminalTab';
import { Button } from './ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { ClosableTab, Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const TOOLS: { kind: Exclude<TabKind, 'file' | 'diff' | 'launcher'>; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
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
  const fileIds = [...new Set(tabs.flatMap((t) => t.kind === 'file' || t.kind === 'diff' ? [t.materialId] : []))];
  const material = useLive(async () => (await Promise.all(fileIds.map((id) => call('material.read', { id })))).flatMap((r) => r.ok ? [r.value.entry] : []), [fileIds.join(',')], [] as MaterialEntry[]);
  const active = tabs.find((t) => t.id === prefs.pane.active) ?? tabs[0];
  const realTabs = tabs.filter((tab) => tab.kind !== 'launcher');
  const nameOf = (id: string) => material.find((m) => m.id === id)?.name;
  const label = (t: PaneTab) => t.kind === 'file' ? `${nameOf(t.materialId) ?? 'File'}${t.version === undefined ? '' : ` · v${t.version}`}` : t.kind === 'diff' ? `${nameOf(t.materialId) ?? 'File'} · v${t.version} changes` : t.kind === 'launcher' ? 'New tab' : TOOLS.find((x) => x.kind === t.kind)?.label ?? t.kind;
  const [fileActionsTarget, setFileActionsTarget] = React.useState<HTMLDivElement | null>(null);
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
    <aside aria-label="Side pane" data-workspace data-testid="pane" className={cn('fixed inset-0 z-50 flex flex-col bg-surface lg:static lg:z-auto lg:h-full lg:w-full', !prefs.pane.open && 'hidden')}>
      <Tabs value={active?.id ?? ''} onValueChange={(id) => setPrefs((p) => ({ ...p, pane: { ...p.pane, active: id } }))} activationMode="manual" className="flex h-full min-h-0 flex-col">
        <div data-workspace-bar data-testid="workspace-bar" className="app-window-bar flex h-[42px] min-w-0 shrink-0 items-center gap-1 border-b border-border bg-bg px-2">
          <TabsList aria-label="Pane tabs" className="min-w-0 flex-1 justify-start overflow-x-auto">
            {realTabs.map((tab) => {
              const Icon = tab.kind === 'diff' ? Diff : TOOLS.find((t) => t.kind === tab.kind)?.icon ?? Plus;
              return (
                <ClosableTab key={tab.id} value={tab.id} title={label(tab)} active={tab.id === active?.id} closeLabel={`Close ${label(tab)}`} onClose={() => { closeTab(tab.id); focusLater('[data-testid=pane] [role=tab][aria-selected=true]', '[data-testid=pane] [aria-label="New tab"]', '[data-pane-toggle]'); }}>
                  {tab.kind === 'file' ? <FileIcon name={label(tab)} /> : <Icon className="size-4 text-muted" aria-hidden />}
                  <span className="truncate">{label(tab)}</span>
                </ClosableTab>
              );
            })}
          </TabsList>
          {realTabs.length > 0 ? <Button variant="ghost" size="icon-sm" aria-label="New tab" onClick={openLauncher}><Plus /></Button> : <Button variant="outline" size="sm" onClick={openLauncher}>Open…</Button>}
          <div ref={setFileActionsTarget} role="group" aria-label="Document actions" className="flex shrink-0 items-center gap-1" />
          {active?.kind === 'file' && <Button variant="ghost" size="icon-sm" aria-label="Browse files" aria-pressed={besideFile} onClick={() => availableWidth < 500 ? openTab('files') : setBrowserOpen((open) => !open)}><FolderTree /></Button>}
          <Button variant="ghost" size="icon-sm" aria-label="Close pane" onClick={() => { setPaneOpen(false); focusLater('[data-pane-toggle]'); }}><X /></Button>
        </div>
        <Group elementRef={groupElement} className="min-h-0 flex-1" onLayoutChanged={(sizes, meta) => { if (meta.isUserInteraction && active?.kind === 'file') setBrowserOpen(sizes['workspace-browser'] > 0); }}>
          <Panel id="workspace-reader" panelRef={reader} minSize="220px" defaultSize="100%" collapsible collapsedSize="0px" className="h-full min-w-0">
            {!projectId ? <p className="p-4 text-sm text-muted">Choose a project to see its files and tools.</p> : (
              <>
                {prefs.pane.open && active?.kind === 'launcher' && <section aria-label="Open a file or tool" className="h-full"><Launcher /></section>}
                {tabs.filter((tab) => tab.kind !== 'files' && tab.kind !== 'launcher').map((tab) => (
                  <TabsContent key={tab.id} value={tab.id} forceMount className="h-full data-[state=inactive]:hidden">
                    {tab.kind === 'file' ? <FileTab key={tab.id} materialId={tab.materialId} version={tab.version} active={active?.id === tab.id} headerTarget={prefs.pane.open && active?.id === tab.id ? fileActionsTarget : null} onSaved={() => {
                      if (tab.version === undefined) return;
                      setPrefs((current) => {
                        if (current.pane.active !== tab.id || !current.pane.tabs.some((x) => x.id === tab.id)) return current;
                        const id = tabId('file', tab.materialId);
                        const tabs = current.pane.tabs.filter((x) => x.id !== tab.id);
                        if (!tabs.some((x) => x.id === id)) tabs.push({ id, kind: 'file', materialId: tab.materialId });
                        return { ...current, pane: { ...current.pane, tabs, active: id } };
                      });
                    }} /> : tab.kind === 'diff' ? <VersionChanges projectId={projectId} materialId={tab.materialId} version={tab.version} name={nameOf(tab.materialId)} /> : tab.kind === 'changes' ? <ChangesTab projectId={projectId} threadId={threadId} /> : tab.kind === 'terminal' ? <TerminalTab key={projectId} projectId={projectId} active={prefs.pane.open && active?.id === tab.id} /> : threadId ? <SideChatTab threadId={threadId} /> : <p className="p-4 text-sm text-muted">Open a thread to start a side chat.</p>}
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
