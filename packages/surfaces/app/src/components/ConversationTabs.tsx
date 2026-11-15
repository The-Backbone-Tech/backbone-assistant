// Window-local views. Closing one never archives a conversation or stops its work.
// Thread owns its data/actions; a React portal places its menu in this shared window bar.
import { Menu, MessageSquare, PanelRight, Plus } from 'lucide-react';
import * as React from 'react';
import { useApp } from '../lib/state';
import { lastActive } from '../lib/when';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { ClosableTab, TabStrip, Tabs, TabsContent, TabsTrigger } from './ui/tabs';

const ConversationBar = React.createContext<{ target: HTMLDivElement | null; hasTabs: boolean; closeView?: () => void }>({ target: null, hasTabs: false });
export const useConversationBar = () => React.useContext(ConversationBar);

export function ConversationTabs({ children }: { children: React.ReactNode }) {
  const { remote, prefs, threads, projects, selectThread, selectProject, setSidebarOpen, setPaneOpen } = useApp();
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
  // After closing, the keyboard goes to the conversation now shown, or to the message box when one conversation
  // is left and the row of tabs has gone (the closed tabs and their menu no longer exist).
  const focusShown = () => setTimeout(() => ['[data-conversation-bar] [role=tab][aria-selected=true]', '[data-testid=composer] textarea'].map((s) => document.querySelector<HTMLElement>(s)).find(Boolean)?.focus());
  // `refocus` is false when the list of all tabs closes one: the keyboard stays in that list.
  const close = (id: string, refocus = true) => {
    const index = shown.findIndex((thread) => thread.id === id);
    const remaining = shown.filter((thread) => thread.id !== id);
    setIds(remaining.map((thread) => thread.id));
    if (selected === id) selectThread(remaining[index]?.id ?? remaining[index - 1]?.id);
    if (refocus) focusShown();
  };
  // Keep one conversation's tab and close the others' views: it becomes the one shown; nothing stops.
  const closeOthers = (id: string) => {
    setIds([id]);
    if (selected !== id) selectThread(id);
    focusShown();
  };
  // In the list of all tabs, chats that begin with the same words are told apart by their project and when each was last active.
  const note = (thread: (typeof shown)[number]) => [projects.find((project) => project.id === thread.projectId)?.name, lastActive(thread.updatedAt)].filter(Boolean).join(' · ');
  const place = prefs.view === 'now' ? 'Now' : prefs.view === 'brief' ? 'Mail triage' : prefs.view === 'scheduled' ? 'Scheduled' : prefs.view === 'memory' ? 'Memory' : 'New chat';
  const context = { target, hasTabs, closeView: () => { if (selected) close(selected); } };
  return (
    <ConversationBar.Provider value={context}>
      <Tabs value={selected ?? 'home'} onValueChange={(id) => id === 'home' ? selectProject(prefs.selectedProjectId) : selectThread(id)} activationMode="manual" data-tab-scope className="flex min-h-0 flex-1 flex-col">
        <header data-conversation-bar data-testid="conversation-bar" className="app-window-bar flex h-[42px] min-w-0 shrink-0 items-center gap-1 border-b border-border bg-bg px-2">
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open sidebar" tip onClick={() => setSidebarOpen(true)}><Menu /></Button>
          {hasTabs && (
            <>
              <TabStrip label="Open conversations" value={selected ?? 'home'} tabs={[...(!selectedThread ? [{ value: 'home', label: place }] : []), ...shown.map((thread) => ({ value: thread.id, label: thread.title, detail: thread.running ? 'working' : undefined, note: note(thread), icon: <MessageSquare className="text-muted" aria-hidden />, closeLabel: `Close conversation view ${thread.title}`, onClose: () => close(thread.id, false) }))]} onChoose={(id) => id === 'home' ? selectProject(prefs.selectedProjectId) : selectThread(id)}>
                {!selectedThread && <TabsTrigger value="home" className="h-8 shrink-0 px-3 text-ui">{place}</TabsTrigger>}
                {shown.map((thread) => (
                  <ClosableTab key={thread.id} value={thread.id} title={thread.running ? `${thread.title} · working` : thread.title} active={thread.id === selected} closeLabel={`Close conversation view ${thread.title}`} onClose={() => close(thread.id)} onCloseOthers={shown.length > 1 ? () => closeOthers(thread.id) : undefined}>
                    <MessageSquare className="text-muted" aria-hidden /><span className="truncate">{thread.title}</span>
                  </ClosableTab>
                ))}
              </TabStrip>
              <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="New conversation" tip onClick={() => selectProject(prefs.selectedProjectId)}><Plus /></Button>
            </>
          )}
          {/* The open conversation's menu, at the far end; the empty space between moves the window. */}
          <div ref={setTarget} className={cn('flex min-w-0 flex-1 items-center', hasTabs && 'min-w-fit justify-end')}>
            {!selectedThread && !hasTabs && <span className="px-2 text-ui text-muted">{place}</span>}
          </div>
          {!remote&&<Button data-pane-toggle variant="ghost" size="icon-sm" className="shrink-0" aria-label={prefs.pane.open ? 'Hide side pane' : 'Show side pane'} tip aria-pressed={prefs.pane.open} onClick={() => setPaneOpen(!prefs.pane.open)}><PanelRight /></Button>}
        </header>
        <TabsContent value={selected ?? 'home'} forceMount {...(!hasTabs ? { role: 'region', 'aria-label': selectedThread?.title ?? place, 'aria-labelledby': undefined } : {})} className="flex min-h-0 flex-1 flex-col">{children}</TabsContent>
      </Tabs>
    </ConversationBar.Provider>
  );
}
