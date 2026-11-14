// Window-local views. Closing one never archives a conversation or stops its work.
// Thread owns its data/actions; a React portal places its menu in this shared window bar.
import { Menu, MessageSquare, PanelRight, Plus } from 'lucide-react';
import * as React from 'react';
import { useApp } from '../lib/state';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { ClosableTab, Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const ConversationBar = React.createContext<{ target: HTMLDivElement | null; hasTabs: boolean; closeView?: () => void }>({ target: null, hasTabs: false });
export const useConversationBar = () => React.useContext(ConversationBar);

export function ConversationTabs({ children }: { children: React.ReactNode }) {
  const { remote, prefs, threads, selectThread, selectProject, setSidebarOpen, setPaneOpen } = useApp();
  const [ids, setIds] = React.useState<string[]>([]);
  const [target, setTarget] = React.useState<HTMLDivElement | null>(null);
  const selected = prefs.selectedThreadId;
  const selectedThread = threads.find((thread) => thread.id === selected);
  React.useEffect(() => {
    if (selectedThread) setIds((old) => old.includes(selectedThread.id) ? old : [...old, selectedThread.id]);
  }, [selectedThread?.id]);
  const shown = [...new Set([...ids, ...(selectedThread ? [selectedThread.id] : [])])]
    .flatMap((id) => threads.filter((thread) => thread.id === id));
  const hasTabs = shown.length > 1 || (!selectedThread && shown.length > 0);
  const close = (id: string) => {
    const index = shown.findIndex((thread) => thread.id === id);
    const remaining = shown.filter((thread) => thread.id !== id);
    setIds(remaining.map((thread) => thread.id));
    if (selected === id) selectThread(remaining[index]?.id ?? remaining[index - 1]?.id);
  };
  const place = prefs.view === 'now' ? 'Now' : prefs.view === 'brief' ? 'Mail triage' : prefs.view === 'scheduled' ? 'Scheduled' : prefs.view === 'memory' ? 'Memory' : 'New chat';
  const context = { target, hasTabs, closeView: () => { if (selected) close(selected); } };
  return (
    <ConversationBar.Provider value={context}>
      <Tabs value={selected ?? 'home'} onValueChange={(id) => id === 'home' ? selectProject(prefs.selectedProjectId) : selectThread(id)} activationMode="manual" className="flex min-h-0 flex-1 flex-col">
        <header data-conversation-bar data-testid="conversation-bar" className="app-window-bar flex h-[42px] min-w-0 shrink-0 items-center gap-1 border-b border-border bg-bg px-2">
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><Menu /></Button>
          {hasTabs && (
            <TabsList aria-label="Open conversations" className="min-w-0 flex-1 justify-start overflow-x-auto">
              {!selectedThread && <TabsTrigger value="home" className="h-8 px-3 text-ui">{place}</TabsTrigger>}
              {shown.map((thread) => (
                <ClosableTab key={thread.id} value={thread.id} title={thread.title} active={thread.id === selected} closeLabel={`Close conversation view ${thread.title}`} onClose={() => close(thread.id)}>
                  <MessageSquare className="text-muted" aria-hidden /><span className="truncate">{thread.title}</span>
                </ClosableTab>
              ))}
              <Button variant="ghost" size="icon-sm" aria-label="New conversation" title="New conversation" onClick={() => selectProject(prefs.selectedProjectId)}><Plus /></Button>
            </TabsList>
          )}
          <div ref={setTarget} className={cn('flex min-w-0 items-center', !hasTabs && 'flex-1')}>
            {!selectedThread && !hasTabs && <span className="px-2 text-ui text-muted">{place}</span>}
          </div>
          {!remote&&<Button data-pane-toggle variant="ghost" size="icon-sm" aria-label={prefs.pane.open ? 'Hide side pane' : 'Show side pane'} title={prefs.pane.open ? 'Hide workspace' : 'Show workspace'} aria-pressed={prefs.pane.open} onClick={() => setPaneOpen(!prefs.pane.open)}><PanelRight /></Button>}
        </header>
        <TabsContent value={selected ?? 'home'} forceMount {...(!hasTabs ? { role: 'region', 'aria-label': selectedThread?.title ?? place, 'aria-labelledby': undefined } : {})} className="flex min-h-0 flex-1 flex-col">{children}</TabsContent>
      </Tabs>
    </ConversationBar.Provider>
  );
}
