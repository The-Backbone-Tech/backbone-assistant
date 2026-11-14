// App state: projections read through the api port, refreshed on its events, plus per-viewer prefs.
import type { HostStatus, ModelChoice, PaneTab, Project, ThreadSummary, ViewerPrefs } from '@backbone-next/platform';
import { DEFAULT_PREFS } from '@backbone-next/platform';
import * as React from 'react';
import type { RemoteView } from './api';
import { beforeClose, call, onEvent, setWindowTheme } from './api';
import { approveCloseWithoutConflictCopies, ConflictCopyError, flushDrafts } from './drafts';
import { createViewerLayoutWriter, retainedViewerLayout } from './viewer-layout';
import { layoutPerson } from './identity-startup';

export type TabKind = PaneTab['kind'];

interface AppState {
  remote?:RemoteView;
  ready: boolean;
  identityRecovery?:{available:boolean;notice?:string};
  sentNotice?: { threadId: string; detail: string; target?: 'side-chat'; attention?: boolean };
  showSentNotice(threadId: string, detail?: string, target?: 'side-chat', attention?: boolean): void;
  dismissSentNotice(): void;
  /** Set when the app could not start: what failed, in plain words, with no value from the home. */
  failed?: string;
  /** Set when another process owns this data home: the app shows who, and opens nothing else. */
  held?: HostStatus;
  projects: Project[];
  threads: ThreadSummary[];
  models: ModelChoice[];
  prefs: ViewerPrefs;
  /** Increments on every api event; live queries refetch on it. */
  tick: number;
  dark: boolean;
  setPrefs(update: (p: ViewerPrefs) => ViewerPrefs): void;
  selectThread(id: string | undefined): void;
  selectProject(id: string | undefined): void;
  openTab(kind: TabKind, materialId?: string, version?: number): void;
  closeTab(id: string): void;
  setPaneOpen(open: boolean): void;
  sidebarOpen: boolean;
  setSidebarOpen(open: boolean): void;
}

const Ctx = React.createContext<AppState | null>(null);

export function useApp(): AppState {
  const s = React.useContext(Ctx);
  if (!s) throw new Error('useApp outside AppProvider');
  return s;
}

export const tabId = (kind: TabKind, materialId?: string, version?: number) => (kind === 'file' || kind === 'diff' ? `${kind}:${materialId}${version === undefined ? '' : `:v${version}`}` : kind);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [remote,setRemote]=React.useState<RemoteView>();
  const remoteState=React.useRef<RemoteView|undefined>(undefined);
  const booted=React.useRef(false);
  const [ready, setReady] = React.useState(false);
  const [identityRecovery,setIdentityRecovery]=React.useState<{available:boolean;notice?:string}>();
  const [failed, setFailed] = React.useState<string>();
  const [held, setHeld] = React.useState<HostStatus>();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [models, setModels] = React.useState<ModelChoice[]>([]);
  const [prefs, setPrefsState] = React.useState<ViewerPrefs>(DEFAULT_PREFS);
  const currentPrefs = React.useRef<ViewerPrefs>(DEFAULT_PREFS);
  const currentPerson=React.useRef<string|undefined>(undefined);
  const retained=React.useMemo(()=>retainedViewerLayout<ViewerPrefs>(sessionStorage),[]);
  const [tick, setTick] = React.useState(0);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [systemDark, setSystemDark] = React.useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  const [sentNotice, setSentNotice] = React.useState<{ threadId: string; detail: string; target?: 'side-chat'; attention?: boolean }>();
  const [closeError, setCloseError] = React.useState<string>();
  const [unkeptConflicts, setUnkeptConflicts] = React.useState<string[]>([]);

  const save=React.useMemo(()=>createViewerLayoutWriter<ViewerPrefs>({
    write:async prefs=>{await call('viewer.put',{prefs});},
    retain:prefs=>{if(!currentPerson.current)throw new Error('The layout owner is not available.');retained.retain(currentPerson.current,prefs);},
  }),[retained]);
  const setPrefs = React.useCallback(
    (update: (p: ViewerPrefs) => ViewerPrefs) => {
      if(save.retired())return;
      const next = update(currentPrefs.current);
      currentPrefs.current = next;
      setPrefsState(next);
      void save.set('viewer', next).catch(() => setCloseError('The workspace layout could not be saved. Your work is still open.'));
    },
    [save],
  );

  // A reload has no close to wait for: send what is waiting as the page goes, and leave the layout
  // for the next page, whose first read can overtake that save.
  React.useEffect(() => {
    const leave = () => {
      const unsaved = save.get('viewer');
      void flushDrafts().catch(() => {});
      void save.flush().catch(() => {});
      try {
        // Only a layout still on its way: anything already stored stays the truth.
        const person=currentPerson.current;
        if (unsaved&&person) retained.retain(person,unsaved);
        else if(person&&!save.retired())retained.clear(person);
      } catch { /* the save still runs */ }
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [save,retained]);

  React.useEffect(() => beforeClose(
    async () => {
      // Once closing starts, accept no keystroke after the snapshot we are draining.
      document.documentElement.inert = true;
      try { await flushDrafts(); } catch (error) {
        if (error instanceof ConflictCopyError) setUnkeptConflicts(error.keys);
        throw error;
      }
      setUnkeptConflicts([]);
      await save.flush();
    },
    (message) => { document.documentElement.inert = false; setCloseError(message); },
  ), [save]);

  const refresh = React.useCallback(async () => {
    if(save.retired())return;
    const [p, t] = await Promise.all([call('projects.list', {}), call('threads.list', {})]);
    if(save.retired())return;
    setProjects(p);
    setThreads(t);
  }, [save]);

  React.useEffect(() => {
    let booting=false,live=true;
    const start=async () => {
      if(booting||booted.current||save.retired())return;booting=true;
      const configuration=await window.backbone?.identityConfiguration?.().catch(()=>undefined);
      remoteState.current=configuration?.remote;if(live)setRemote(configuration?.remote);
      // Asked first: on a home another process owns, every other call fails, and the window would half work.
      const status = await call('host.status', {}).catch(() => null);
      if (status && !status.owns) { setHeld(status); setReady(true);booting=false; return; }
      const recovery=await window.backbone?.identityRecoveryStatus?.().catch(()=>undefined);
      setIdentityRecovery(recovery);
      try {
        const [person,stored,m]=await Promise.all([layoutPerson(()=>call('identity.get',{})),call('viewer.get',{}),call('models.list',{})]);
        currentPerson.current=person;
        const original = retained.read(currentPerson.current) ?? stored;
        const p=configuration?.remote?{...original,view:undefined,pane:{open:false,tabs:[]}}:original;
        currentPrefs.current = p;
        setPrefsState(p);
        setModels(m);
        await refresh();if(!save.retired()){setFailed(undefined);booted.current=true;}
      } catch (error) {
        const current=await window.backbone?.identityConfiguration?.().catch(()=>undefined);
        const remote=current?.remote??configuration?.remote;
        // A blank window says nothing. Say which kind of failure stopped the start, in fixed words:
        // an error's own message can carry what was being read, so it is never shown.
        const kind = /^Error invoking remote method '[^']+': (\w+)/.exec(String((error as Error)?.message ?? ''))?.[1];
        const identityPaused=kind==='IdentityUnavailable'||(error instanceof Error&&error.name==='IdentityUnavailable');
        setFailed(remote?(remote.connection==='ended'?'Your workspace access ended. Sign in again.':'Temporary workspace connection problem. Reconnecting automatically.'):identityPaused?(recovery?.notice??'Team features are paused on this Mac. Your work is safe; export it from Settings › Backup.'):/Sign in to this workspace|IdentityRefused/.test(String(error)) ? 'Sign in to this workspace.' : kind === 'PieceRefused'
          ? 'This data folder did not accept the app\'s engine: open the app again to allow the update, or reinstall the previous app version.'
          : kind === 'KeysRefused'
            ? 'The system keychain could not open this data folder\'s keys.'
            : 'Something stopped the app from opening this data folder.');
      }
      setReady(true);booting=false;
    };
    void start();
    // A single slow fallback refreshes the open conversation and project permissions,
    // including idle viewer changes. It never replays a mutation or opens another stream.
    const fallback=setInterval(()=>{
      if(!remoteState.current||save.retired())return;
      void window.backbone?.identityConfiguration?.().then(configuration=>{remoteState.current=configuration.remote;if(live)setRemote(configuration.remote);});
      if(!booted.current)void start();
      else {setTick(value=>value+1);void refresh().catch(()=>{});}
    },5_000);
    // Events come in bursts: a running turn saves its thread many times a second. A burst becomes one
    // refresh in flight and, if more came meanwhile, one more after a short pause, never a pile of reads.
    let refreshing = false;
    let again = false;
    const pulse = async () => {
      if (refreshing) { again = true; return; }
      refreshing = true;
      try {
        do {
          again = false;
          setTick((n) => n + 1);
          await refresh().catch(() => {});
          if (again) await new Promise((r) => setTimeout(r, 50));
        } while (again);
      } finally {
        refreshing = false;
      }
    };
    const off = onEvent((e) => {
      if(e.topic==='identity'&&e.urgent?.startsWith('Access ended')){void save.endAccess().catch(()=>setCloseError('The layout could not be retained locally. Your work is still open.'));setProjects([]);setThreads([]);currentPrefs.current=DEFAULT_PREFS;setPrefsState(DEFAULT_PREFS);setFailed('Your workspace access ended. Sign in again.');return;}
      if(save.retired())return;
      void pulse();
      // A changed model route changes what the composer offers.
      if (e.topic === 'settings') void call('models.list', {}).then(setModels);
    });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onMq);
    return () => (live=false, clearInterval(fallback),off(), mq.removeEventListener('change', onMq));
  }, [refresh,retained]);

  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark);
  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    setWindowTheme(prefs.theme);
  }, [dark, prefs.theme]);

  const value: AppState = {
    sentNotice,
    showSentNotice: (threadId, detail = 'An earlier message was sent. Open its chat before sending it again.', target, attention) => { setSentNotice({ threadId, detail, target, attention }); void refresh().catch(() => {}); },
    dismissSentNotice: () => setSentNotice(undefined),
    remote, ready, failed, identityRecovery, held, projects, threads, models, prefs, tick, dark, setPrefs, sidebarOpen, setSidebarOpen,
    selectThread: (id) => {
      setSidebarOpen(false);
      setPrefs((p) => ({ ...p, view: undefined, selectedThreadId: id, selectedProjectId: id ? (threads.find((t) => t.id === id)?.projectId ?? p.selectedProjectId) : p.selectedProjectId }));
      if (!remote && id && threads.find((t) => t.id === id)?.unread) void call('threads.update', { id, patch: { unread: false } });
    },
    selectProject: (id) => setPrefs((p) => ({ ...p, view: undefined, selectedProjectId: id, selectedThreadId: undefined })),
    openTab: (kind, materialId, version) =>
      !remote && setPrefs((p) => {
        const id = tabId(kind, materialId, version);
        const tab = (kind === 'file' ? { id, kind, materialId: materialId ?? '', ...(version === undefined ? {} : { version }) } : kind === 'diff' ? { id, kind, materialId: materialId ?? '', version: version ?? 1 } : { id, kind }) as PaneTab;
        const tabs = p.pane.tabs.some((t) => t.id === id) ? p.pane.tabs : [...p.pane.tabs, tab];
        return { ...p, pane: { open: true, tabs, active: id } };
      }),
    closeTab: (id) =>
      setPrefs((p) => {
        const tabs = p.pane.tabs.filter((t) => t.id !== id);
        const active = p.pane.active === id ? tabs.at(-1)?.id : p.pane.active;
        return { ...p, pane: { open: tabs.length > 0 && p.pane.open, tabs, active } };
      }),
    setPaneOpen: (open) =>
      setPrefs((p) => {
        if (open && p.pane.tabs.length === 0) return { ...p, pane: { open, tabs: [{ id: 'launcher', kind: 'launcher' }], active: 'launcher' } };
        return { ...p, pane: { ...p.pane, open } };
      }),
  };
  return <Ctx.Provider value={value}>{closeError && <div role="alert" className="fixed inset-x-0 bottom-0 z-50 border-t border-danger bg-bg p-3 text-sm text-danger">
    <p>{closeError}</p>
    {unkeptConflicts.length > 0 && <div><p>A separate copy could not be saved for these unconfirmed drafts: {unkeptConflicts.join(', ')}. Closing without copies loses their local text. You can return and copy or review it first.</p>
      <button type="button" className="underline mr-3" onClick={() => {setUnkeptConflicts([]); setCloseError(undefined);}}>Keep window open</button>
      <button type="button" className="underline" onClick={() => {approveCloseWithoutConflictCopies(unkeptConflicts); window.close();}}>Close without these copies</button>
    </div>}
  </div>}{children}</Ctx.Provider>;
}

/** Runs an api query and reruns it on every api event or when deps change. */
export function useLive<T>(fn: () => Promise<T>, deps: React.DependencyList, initial: T): T {
  const { tick } = useApp();
  const [v, setV] = React.useState<T>(initial);
  // A read is dropped only when a newer one has already landed, or what it reads has changed. Under a
  // stream of events a read is never cancelled merely because another started, so it cannot starve.
  const generation = React.useRef(0);
  const started = React.useRef(0);
  const landed = React.useRef(0);
  React.useEffect(() => {
    generation.current++;
    landed.current = started.current;
    return () => { generation.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  React.useEffect(() => {
    const g = generation.current;
    const n = ++started.current;
    void fn().then((x) => {
      if (g !== generation.current || n <= landed.current) return;
      landed.current = n;
      setV(x);
    }).catch(()=>{});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return v;
}
