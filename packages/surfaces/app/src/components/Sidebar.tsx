// Sidebar, as the old Backbone app had it: an icon rail, then search, New chat, Projects,
// Chats with Show more, More, and Settings and utility controls at the foot (R-UX-SIDEBAR-01). Pins,
// sections, unread state and a row menu stay; child threads fold under their parent. Anything
// without a backend yet is left out rather than shown disabled.
import type { GoalRun, HeldCall, ThreadHit, ThreadSummary } from '@backbone-next/platform';
import { defaultFilter } from 'cmdk';
import {
  Archive, ArchiveRestore, Bell, Brain, CalendarClock, ChevronDown, ChevronRight, Folder, FolderGit2, Loader2, Mail, MessagesSquare, Monitor, Moon,
  MoreHorizontal, PanelLeft, PenSquare, Pin, Plus, Search, Settings, Sun, Trash2, X,
  ListChecks,
} from 'lucide-react';
import * as React from 'react';
import { call, isMac } from '../lib/api';
import { requestComposerFocus } from '../lib/composer-focus';
import { brand } from '../brand';
import { useApp, useLive } from '../lib/state';
import { cn } from '../lib/utils';
import { NewProjectDialog } from './NewProjectDialog';
import { ScheduleDialog, useProactivity } from './Scheduled';
import { ForkRoleNotice } from './ForkRoleNotice';
import { SettingsDialog, type SectionId } from './SettingsDialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Dialog, DialogClose, DialogContent } from './ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { AreaContextMenu, ItemContextMenu, ItemMenuButton, type MenuEntry } from './ui/item-menu';
import { Kbd } from './ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

const FIRST_CHATS = 8;
const item = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-fg hover:bg-hover disabled:pointer-events-none disabled:text-muted [&_svg]:size-4 [&_svg]:shrink-0';

export function Sidebar() {
  const { remote, projects, threads, prefs, setPrefs, selectProject, sidebarOpen, setSidebarOpen } = useApp();
  const [newProject, setNewProject] = React.useState(false);
  const [settings, setSettings] = React.useState(false);
  const [settingsSection, setSettingsSection] = React.useState<SectionId | undefined>(undefined);
  React.useEffect(()=>window.backbone?.onSharingSettings?.(()=>{setSettingsSection('people');setSettings(true);}),[]);
  const openSettings = (section?: SectionId) => { setSettingsSection(section); setSettings(true); };
  const [search, setSearch] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const mac = isMac();
  const live = threads.filter((t) => !t.archived);
  const archived = threads.filter((t) => t.archived);
  const pinned = live.filter((t) => t.pinned);
  const sections = [...new Set(live.filter((t) => !t.pinned && t.section).map((t) => t.section as string))].sort();
  const childrenOf = (id: string) => live.filter((t) => t.parentId === id);
  const chats = live.filter((t) => !t.pinned && !t.section && !t.parentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = showAll ? chats : chats.slice(0, FIRST_CHATS);
  const newChat = React.useCallback(() => { selectProject(prefs.selectedProjectId); setSidebarOpen(false); requestComposerFocus(); }, [selectProject, prefs.selectedProjectId, setSidebarOpen]);

  React.useEffect(() => window.backbone?.onMacNewChat?.(newChat), [newChat]);

  // New chat: ⇧⌘O (Codex and Claude both use it).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey) && !e.altKey && e.code === 'KeyO') {
        e.preventDefault();
        newChat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mac, newChat]);

  // Open over the page on a narrow window, it holds the keyboard until it closes.
  const closeButton = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!sidebarOpen) return;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog],[data-radix-popper-content-wrapper]')) setSidebarOpen(false); };
    // Capture sees the key before a popover closes on it, so one Escape closes one thing.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setTimeout(() => { if (document.activeElement === document.body || document.activeElement === closeButton.current) document.querySelector<HTMLElement>('[aria-label="Open sidebar"]')?.focus(); });
    };
  }, [sidebarOpen, setSidebarOpen]);
  return (
    <>
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden />}
      <div data-sidebar-collapsed={collapsed} className={cn('z-40 shrink-0 md:static md:flex', sidebarOpen ? 'fixed inset-y-0 left-0 flex' : 'hidden')}>
        <Rail collapsed={collapsed} onExpand={() => setCollapsed(false)} />
        <nav
          aria-label="Projects and threads"
          className={cn('flex w-72 flex-col border-r border-border bg-sidebar md:w-60', collapsed && 'md:hidden')}
        >
          <div className="app-window-bar app-sidebar-bar flex h-[42px] shrink-0 items-center gap-1 pl-3 pr-2">
            <span className="min-w-0 truncate text-sm font-semibold tracking-tight" title={brand.name}>{brand.name}</span>
            <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Search chats" tip onClick={() => setSearch(true)}>
              <Search />
            </Button>
            <Button variant="ghost" size="icon-sm" className="hidden md:inline-flex" aria-label="Collapse sidebar" tip onClick={() => setCollapsed(true)}>
              <PanelLeft />
            </Button>
            <Button ref={closeButton} variant="ghost" size="icon-sm" className="md:hidden" aria-label="Close sidebar" tip onClick={() => setSidebarOpen(false)}>
              <X />
            </Button>
          </div>

          <div className="px-2">
            <button type="button" className={item} onClick={newChat}>
              <PenSquare className="text-muted" /> New chat
              <Kbd aria-hidden>{mac ? '⇧⌘O' : 'Ctrl+Shift+O'}</Kbd>
            </button>
          </div>

          <AreaContextMenu entries={[
            { kind: 'item', id: 'new-chat', label: 'New chat', onSelect: newChat },
            ...(remote ? [] : [{ kind: 'item' as const, id: 'new-project', label: 'New project', onSelect: () => setNewProject(true) }]),
          ]}>
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <Section
              title="Projects"
              action={
                !remote&&<Button variant="ghost" size="icon-sm" aria-label="New project" tip onClick={() => setNewProject(true)}>
                  <Plus />
                </Button>
              }
            >
              {projects.length === 0 && <p className="px-2 py-1 text-xs text-muted">No projects yet.</p>}
              {projects.map((p) => (
                <ProjectRow key={p.id} project={p} threads={live.filter((t) => t.projectId === p.id && !t.parentId)} childrenOf={childrenOf} />
              ))}
            </Section>
            {pinned.length > 0 && (
              <Section title="Pinned">
                {pinned.map((t) => (
                  <Row key={t.id} thread={t} childrenOf={childrenOf} />
                ))}
              </Section>
            )}
            {sections.map((s) => (
              <Section key={s} title={s}>
                {live.filter((t) => !t.pinned && t.section === s && !t.parentId).map((t) => (
                  <Row key={t.id} thread={t} childrenOf={childrenOf} />
                ))}
              </Section>
            ))}
            <Section title="Chats">
              {chats.length === 0 && <p className="px-2 py-1 text-xs text-muted">No chats yet.</p>}
              {shown.map((t) => (
                <Row key={t.id} thread={t} childrenOf={childrenOf} />
              ))}
            </Section>
            {chats.length > FIRST_CHATS && (
              <button type="button" className={cn(item, 'text-muted')} onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show less' : 'Show more'}
              </button>
            )}
            {!remote&&<MoreMenu archived={archived} />}
          </div>
          </AreaContextMenu>

          <div className="space-y-0.5 border-t border-border p-2">
            <div className="flex items-center gap-1">
              {!remote&&<button type="button" className={cn(item, 'flex-1')} onClick={() => openSettings()}>
                <Settings className="text-muted" /> Settings
              </button>}
              {!remote&&<NeedsYou onHeld={() => openSettings('connectors')} />}
              <div className="flex shrink-0 items-center rounded-md bg-sunken p-0.5" role="group" aria-label="Theme">
                {(
                  [
                    ['light', Sun, 'Light'],
                    ['dark', Moon, 'Dark'],
                    ['system', Monitor, 'System'],
                  ] as const
                ).map(([id, Icon, label]) => (
                  <Button
                    key={id}
                    variant="ghost"
                    size="icon-sm"
                    className={cn('text-muted', prefs.theme === id && 'bg-surface text-fg shadow-sm')}
                    aria-label={`${label} theme`}
                    tip
                    aria-pressed={prefs.theme === id}
                    onClick={() => setPrefs((p) => ({ ...p, theme: id }))}
                  >
                    <Icon />
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </nav>
      </div>
      <NewProjectDialog open={newProject} onOpenChange={setNewProject} />
      {!remote&&<SettingsDialog open={settings} onOpenChange={setSettings} section={settingsSection} />}
      <SearchDialog open={search} onOpenChange={setSearch} />
    </>
  );
}

/** The rail: the app's places. A place joins it when it works. */
function Rail({ collapsed, onExpand }: { collapsed: boolean; onExpand: () => void }) {
  return (
    <div className="app-rail hidden w-11 flex-col items-center gap-1 border-r border-border bg-sidebar py-2 md:flex">
      <Button variant="ghost" size="icon" className="bg-hover" aria-label={collapsed ? 'Expand sidebar' : 'Chats'} tip aria-pressed={!collapsed ? true : undefined} onClick={onExpand}>
        <MessagesSquare />
      </Button>
    </div>
  );
}

/** The one daily brief: what waited for the person since the last, each item one click. */
function NeedsYou({ onHeld }: { onHeld: () => void }) {
  const { selectThread, setPrefs, setSidebarOpen } = useApp();
  const [open, setOpen] = React.useState(false);
  const brief = useProactivity().brief.latest;
  const waiting = brief?.items.filter((i) => !i.done) ?? [];
  const { threads } = useApp();
  const goals = useLive(() => call('goals.runs', {}).then((r) => r ?? [], () => [] as GoalRun[]), [], [] as GoalRun[]).filter((r) => r.status === 'blocked' || r.status === 'budget' || r.status === 'interrupted');
  // A change a connected tool asked for waits on the person's own word, in Connected tools: it counts here too.
  const held = useLive(() => call('connectors.list', {}).then((v) => (v?.held ?? []).filter((h) => h.state === 'waiting' || h.state === 'unknown'), () => [] as HeldCall[]), [], [] as HeldCall[]);
  const count = waiting.length + goals.length + held.length;
  const take = (id: string, threadId: string | null) => {
    void call('brief.done', { id });
    setOpen(false);
    setSidebarOpen(false);
    if (threadId) selectThread(threadId);
    else setPrefs((p) => ({ ...p, view: 'scheduled', selectedThreadId: undefined }));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="relative shrink-0 text-muted"
          aria-label={count > 0 ? `Needs you (${count})` : 'Needs you'}
          tip
        >
          <Bell aria-hidden />
          {count > 0 && <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-draft" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label="Needs you" data-testid="needs-you">
        {goals.length > 0 && <>
          <p className="text-sm font-medium">Goals waiting for you</p>
          <ul className="mb-2 mt-1 flex flex-col">
            {goals.map((g) => (
              <li key={g.threadId}>
                <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-hover" data-testid="goal-waiting" onClick={() => { setOpen(false); setSidebarOpen(false); selectThread(g.threadId); }}>
                  <span className="block text-sm">{g.detail || (g.status === 'budget' ? 'Out of turns' : g.status === 'interrupted' ? 'Interrupted' : 'Blocked')}</span>
                  <span className="block text-xs text-muted">{threads.find((t) => t.id === g.threadId)?.title ?? 'A chat'} · {g.status === 'budget' ? 'out of turns' : g.status === 'interrupted' ? 'interrupted when the app stopped' : 'needs a decision'}</span>
                </button>
              </li>
            ))}
          </ul>
        </>}
        {held.length > 0 && <>
          <p className="text-sm font-medium">Held for you</p>
          <ul className="mb-2 mt-1 flex flex-col">
            {held.map((h) => (
              <li key={h.effect}>
                <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-hover" data-testid="held-waiting" onClick={() => { setOpen(false); setSidebarOpen(false); onHeld(); }}>
                  <span className="line-clamp-2 block text-sm">{h.statement}</span>
                  <span className="block text-xs text-muted">{h.serverName} · {h.state === 'unknown' ? 'unknown outcome: inspect in Connected tools' : 'waits for you in Connected tools'}</span>
                </button>
              </li>
            ))}
          </ul>
        </>}
        {waiting.length === 0 ? goals.length + held.length > 0 ? null : <>
          <p className="text-sm font-medium">Nothing needs you</p>
          <p className="mt-1 text-xs text-muted">What needs you gathers into one daily brief. Only a security or money emergency comes sooner.</p>
        </> : <>
          <p className="text-sm font-medium">Daily brief</p>
          <ul className="mt-1 flex flex-col">
            {waiting.map((i) => (
              <li key={i.id}>
                <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-hover" data-testid="brief-item" onClick={() => take(i.id, i.threadId)}>
                  <span className="block text-sm">{i.title}</span>
                  <span className="block text-xs text-muted">{i.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </>}
      </PopoverContent>
    </Popover>
  );
}

function MoreMenu({ archived }: { archived: ThreadSummary[] }) {
  const { selectThread, prefs, setPrefs, setSidebarOpen } = useApp();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(item, 'mt-1')}>
          <MoreHorizontal className="text-muted" /> More <ChevronRight className="ml-auto text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-64">
        {([
          ['now', 'Now', ListChecks],
          ['scheduled', 'Scheduled', CalendarClock],
          ['memory', 'Memory', Brain],
          ['brief', 'Mail triage', Mail],
        ] as const).map(([view, label, Icon]) => (
          <DropdownMenuItem
            key={view}
            aria-current={prefs.view === view ? 'page' : undefined}
            onSelect={() => {
              setPrefs((p) => ({ ...p, view, selectedThreadId: undefined }));
              setSidebarOpen(false);
            }}
          >
            <Icon /> {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={archived.length === 0}>
            <Archive /> Archived chats <span className="ml-auto text-xs text-muted">{archived.length}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
            {archived.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => void call('threads.update', { id: t.id, patch: { archived: false } }).then(() => selectThread(t.id))}>
                <ArchiveRestore /> <span className="truncate">{t.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { threads, projects, selectThread, selectProject } = useApp();
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<ThreadHit[]>([]);
  // The Host owns matching and ranking, including titles and archived conversations.
  React.useEffect(() => {
    setHits([]);
    if (!open || !query.trim()) return;
    let live = true;
    const t = setTimeout(() => void call('threads.search', { query }).then((h) => { if (live) setHits(h ?? []); }, () => {}), 150);
    return () => { live = false; clearTimeout(t); };
  }, [query, open]);
  const FIELD = { title: 'title', words: 'you wrote', answer: 'answer' } as const;
  const matchingProjects = projects
    .map(project => ({ project, score: defaultFilter(`project ${project.name} ${project.id}`, query.trim()) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(match => match.project);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setQuery(''); onOpenChange(o); }}>
      <DialogContent title="Search" bare className="top-[20%] max-w-lg translate-y-0 overflow-hidden">
        <Command label="Search chats and projects" shouldFilter={false} className="max-h-[60vh]">
          <CommandInput placeholder="Search chats, their words and answers…" autoFocus value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {hits.length > 0 && (
              <CommandGroup heading="In chats">
                {hits.map((h, i) => (
                  <CommandItem key={`${h.threadId}:${h.turnId}:${h.field}:${i}`} value={`found ${h.threadId} ${h.turnId ?? ''} ${h.field}`} data-testid="search-hit" onSelect={() => { selectThread(h.threadId); setQuery(''); onOpenChange(false); }}>
                    <MessagesSquare className="text-muted" />
                    <span className="min-w-0 flex-1"><span className="block truncate">{h.title}</span><span className="block truncate text-xs text-muted">{FIELD[h.field]}: {h.snippet}</span></span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {!query.trim() && <CommandGroup heading="Chats">
              {threads.filter((t) => !t.archived).map((t) => (
                <CommandItem key={t.id} value={`chat ${t.title} ${t.id}`} onSelect={() => (selectThread(t.id), onOpenChange(false))}>
                  <MessagesSquare className="text-muted" /> <span className="truncate">{t.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>}
            {matchingProjects.length > 0 && <CommandGroup heading="Projects">
              {matchingProjects.map((p) => (
                <CommandItem key={p.id} value={`project ${p.name} ${p.id}`} onSelect={() => (selectProject(p.id), onOpenChange(false))}>
                  <Folder className="text-muted" /> {p.name}
                </CommandItem>
              ))}
            </CommandGroup>}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(true);
  return (
    <section className="mb-2" aria-label={title}>
      <div className="flex h-7 items-center">
        <button type="button" className="group flex flex-1 items-center gap-1 px-2 text-xs font-medium text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
          {title}
          {open ? <ChevronDown className="size-3 opacity-0 group-hover:opacity-100" /> : <ChevronRight className="size-3" />}
        </button>
        {action}
      </div>
      {open && <ul>{children}</ul>}
    </section>
  );
}

function ProjectRow({ project, threads, childrenOf }: { project: { id: string; name: string; kind: string }; threads: ThreadSummary[]; childrenOf: (id: string) => ThreadSummary[] }) {
  const { prefs, selectProject, setSidebarOpen } = useApp();
  const [open, setOpen] = React.useState(false);
  const Icon = project.kind === 'git' ? FolderGit2 : Folder;
  const selected = prefs.selectedProjectId === project.id && !prefs.selectedThreadId;
  return (
    <li>
      <div className={cn('group flex items-center rounded-md hover:bg-hover', selected && 'bg-accent-soft')}>
        <button type="button" aria-label={open ? 'Hide its chats' : 'Show its chats'} aria-expanded={open} className="flex size-7 shrink-0 items-center justify-center text-muted" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left text-sm" onClick={() => (selectProject(project.id), setSidebarOpen(false))}>
          <Icon className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="truncate">{project.name}</span>
          {threads.length > 0 && <span className="ml-auto text-xs text-muted">{threads.length}</span>}
        </button>
      </div>
      {open && (
        <ul className="ml-5 border-l border-border pl-1">
          {threads.length === 0 && <li className="px-2 py-1 text-xs text-muted">No chats in this project.</li>}
          {threads.map((t) => (
            <Row key={t.id} thread={t} childrenOf={childrenOf} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Row({ thread, childrenOf, depth = 0 }: { thread: ThreadSummary; childrenOf: (id: string) => ThreadSummary[]; depth?: number }) {
  const { remote, prefs, selectThread, projects, threads } = useApp();
  const [renaming, setRenaming] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [scheduling, setScheduling] = React.useState(false);
  const [folded, setFolded] = React.useState(true);
  const kids = childrenOf(thread.id);
  const selected = prefs.selectedThreadId === thread.id;
  const patch = (p: Parameters<typeof call<'threads.update'>>[1]['patch']) => void call('threads.update', { id: thread.id, patch: p });
  const sections = [...new Set(threads.map((t) => t.section).filter(Boolean) as string[])];
  if (!sections.includes('Workstreams')) sections.unshift('Workstreams');

  const entries = threadActions({
    thread, projects, sections, patch,
    rename: () => setRenaming(true), schedule: () => setScheduling(true), remove: () => setConfirmDelete(true),
    fork: () => void call('threads.fork', { id: thread.id, clientKey: crypto.randomUUID() }).then((r) => { if (r.ok) selectThread(r.value.id); }),
  });
  return (
    <li>
      <ItemContextMenu entries={entries} disabled={!!remote} focusTarget="[data-row-main],[data-menu-focus]">
      <div className={cn('group flex items-center rounded-md hover:bg-hover', selected && 'bg-accent-soft hover:bg-accent-soft')} style={{ paddingLeft: depth * 12 }}>
        {kids.length > 0 && (
          <button type="button" aria-label={folded ? 'Show child threads' : 'Hide child threads'} className="px-1 text-muted" onClick={() => setFolded(!folded)}>
            {folded ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        )}
        {renaming ? (
          <Input
            autoFocus
            data-menu-focus
            aria-label="Thread name"
            defaultValue={thread.title}
            size="sm"
            className="m-0.5 min-w-0 flex-1"
            onContextMenu={(e) => e.stopPropagation()}
            onBlur={(e) => (patch({ title: e.target.value.trim() || thread.title }), setRenaming(false))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button type="button" data-row-main className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm" aria-current={selected ? 'page' : undefined} onClick={() => selectThread(thread.id)}>
            <span className={cn('truncate', thread.unread && 'font-semibold')}>{thread.title}</span>
            {thread.running && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" aria-label="Running" />}
            {thread.unread && !thread.running && <span className="ml-auto size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" data-testid="unread-dot" />}
          </button>
        )}
        {!remote&&<ItemMenuButton entries={entries} trigger={
          <Button variant="ghost" size="icon-sm" className="reveal text-muted" aria-label={`Thread actions for ${thread.title}`} tip>
            <MoreHorizontal />
          </Button>
        } />}
      </div>
      </ItemContextMenu>
      {kids.length > 0 && !folded && (
        <ul>
          {kids.map((k) => (
            <Row key={k.id} thread={k} childrenOf={childrenOf} depth={depth + 1} />
          ))}
        </ul>
      )}
      {scheduling && <ScheduleDialog thread={thread} open onClose={() => setScheduling(false)} />}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent title="Delete this thread?" description="The conversation is deleted. Its files stay in the project.">
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="outline" className="border-danger text-danger"
              onClick={() => {
                if (selected) selectThread(undefined);
                void call('threads.delete', { id: thread.id });
                setConfirmDelete(false);
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** A conversation's actions, declared once: its "more" button and a right-click on it both render this list. */
function threadActions({ thread, projects, sections, patch, rename, schedule, remove, fork }: {
  thread: ThreadSummary;
  projects: { id: string; name: string }[];
  sections: string[];
  patch: (p: Parameters<typeof call<'threads.update'>>[1]['patch']) => void;
  rename: () => void;
  schedule: () => void;
  remove: () => void;
  fork: () => void;
}): MenuEntry[] {
  return [
    { kind: 'item', id: 'rename', label: 'Rename', onSelect: rename },
    { kind: 'item', id: 'pin', icon: <Pin />, label: thread.pinned ? 'Unpin' : 'Pin', onSelect: () => patch({ pinned: !thread.pinned }) },
    { kind: 'item', id: 'unread', label: thread.unread ? 'Mark as read' : 'Mark as unread', onSelect: () => patch({ unread: !thread.unread }) },
    { kind: 'item', id: 'schedule', label: 'Schedule…', onSelect: schedule },
    { kind: 'separator', id: 'a' },
    { kind: 'choice', id: 'project', label: 'Project', value: thread.projectId, onValueChange: (v) => patch({ projectId: v }), options: projects.map((p) => ({ value: p.id, label: p.name })) },
    { kind: 'choice', id: 'section', label: 'Section', value: thread.section ?? '', onValueChange: (v) => patch({ section: v }), options: [{ value: '', label: 'None' }, ...sections.map((x) => ({ value: x, label: x }))] },
    { kind: 'sub', id: 'fork', label: 'Fork', note: <ForkRoleNotice />, entries: [{ kind: 'item', id: 'fork-chat', label: 'As a chat', onSelect: fork }] },
    { kind: 'separator', id: 'b' },
    { kind: 'item', id: 'archive', icon: <Archive />, label: 'Archive', onSelect: () => patch({ archived: true }) },
    { kind: 'item', id: 'delete', icon: <Trash2 />, label: 'Delete permanently', danger: true, onSelect: remove },
  ];
}
