import {BackupSection} from './components/settings/Backup';
// The shell: sidebar, the centre (Home or a thread) and the right pane, composed like the
// Codex and Claude desktop apps (reference-baseline §2; R-UX-FAMILIAR-01), in Backbone's colours.
import * as React from 'react';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import { isMac } from './lib/api';
import { SHORTCUTS } from './lib/keys';
import { AppProvider, useApp } from './lib/state';
import { IdentityEntry } from './components/settings/IdentityEntry';
import { Brief } from './components/Brief';
import { Now } from './components/Now';
import { Scheduled } from './components/Scheduled';
import { Memory } from './components/Memory';
import { Urgent } from './components/Urgent';
import { HeldHome } from './components/HeldHome';
import { Home } from './components/Home';
import { Pane } from './components/Pane';
import { Sidebar } from './components/Sidebar';
import { Thread } from './components/Thread';
import { ConversationTabs } from './components/ConversationTabs';

function Shell() {
  const { remote, ready, failed, identityRecovery, held, prefs, threads, projects, openTab, setPaneOpen, sentNotice, selectThread, dismissSentNotice } = useApp();
  const thread = threads.find((t) => t.id === prefs.selectedThreadId);
  const projectId = thread?.projectId ?? (projects.some((p) => p.id === prefs.selectedProjectId) ? prefs.selectedProjectId : undefined);
  const workspace = usePanelRef();
  const [repairError,setRepairError]=React.useState<string>();
  const [repairing,setRepairing]=React.useState(false);
  const repair=async()=>{setRepairing(true);setRepairError(undefined);try{await window.backbone?.restoreDeviceAccess?.();}catch(error){setRepairError(error instanceof Error&&error.message.includes('Another owner manages this workspace.')?'Another owner manages this workspace. Ask them to restore your access.':'Access recovery could not be confirmed. Your data folder is kept; inspect the audit record before retrying.');setRepairing(false);}};
  const [desktop, setDesktop] = React.useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const layout = useDefaultLayout({ id: 'conversation-workspace-v1', onlySaveAfterUserInteractions: true });

  React.useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const change = () => setDesktop(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  React.useLayoutEffect(() => {
    if (!ready) return;
    if (desktop && prefs.pane.open) workspace.current?.expand();
    else workspace.current?.collapse();
  }, [ready, desktop, prefs.pane.open, workspace]);

  React.useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      const s = SHORTCUTS.find((x) => x.match(e, mac));
      if (!s) return;
      e.preventDefault();
      if(!remote)openTab(s.kind);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openTab,remote]);

  if (!ready) return <div className="h-full bg-bg" />;
  if (held) return <HeldHome status={held} />;
  if(!identityRecovery?.available&&(failed==='Sign in to this workspace.'||failed==='Your workspace access ended. Sign in again.'))return <div className="flex h-full items-center justify-center bg-bg p-6 text-fg"><div className="w-full max-w-md"><IdentityEntry /></div></div>;
  if(remote&&failed==='Temporary workspace connection problem. Reconnecting automatically.')return <div className="flex h-full items-center justify-center bg-bg p-6 text-fg"><p role="status">{failed}</p></div>;
  if (failed) return (
    <div className="flex h-full items-center justify-center bg-bg p-6 text-fg" role="alert" data-startup-failed="true">
      <div className="max-w-md space-y-3">
        <h1 className="text-lg font-semibold">The app could not start</h1>
        <p className="text-sm text-fg-muted">{failed}</p>
        <p className="text-sm text-fg-muted">Quit and open the app again to retry.</p>
        {identityRecovery?.available&&<button type="button" className="underline" disabled={repairing} onClick={()=>void repair()}>Restore my access on this Mac</button>}
        {repairError&&<p role="alert" className="text-sm text-danger">{repairError}</p>}
        {failed==='Team features are paused on this Mac. Your work is safe; export it from Settings › Backup.'&&<details><summary className="cursor-pointer underline">Settings › Backup</summary><BackupSection /></details>}
        <IdentityEntry />
      </div>
    </div>
  );
  return (
    <div className="flex h-full overflow-hidden bg-bg text-fg" data-ready="true" data-native-titlebar={window.backbone && isMac() ? 'true' : undefined}>
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {identityRecovery?.notice&&<p role="status" className="border-b border-border px-4 py-2 text-sm">{identityRecovery.notice}</p>}
        {remote&&<div role="status" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-sm"><span className="min-w-0 flex-1 break-all">Workspace at {remote.origin} · Runs on the owner’s computer{remote.connection==='temporary'?' · Temporary connection problem. Reconnecting automatically.':''}</span><LeaveWorkspace /></div>}
        {!remote&&<Urgent />}
        {sentNotice && <div role={sentNotice.attention ? "alert" : "status"} data-testid={sentNotice.attention ? "side-chat-notice" : "sent-notice"} className="flex flex-wrap items-center gap-2 border-b border-border bg-sunken px-4 py-2 text-sm"><p className="min-w-0 flex-1">{sentNotice.detail}</p><button type="button" className="underline" onClick={() => { selectThread(sentNotice.threadId); if (sentNotice.target === 'side-chat') openTab('side-chat'); dismissSentNotice(); }}>{sentNotice.target === 'side-chat' ? 'Open side chat' : 'Open sent chat'}</button></div>}
        <Group
          id="conversation-workspace"
          className="min-h-0 flex-1"
          defaultLayout={layout.defaultLayout}
          disabled={!desktop}
          onLayoutChanged={(sizes, meta) => {
            layout.onLayoutChanged(sizes, meta);
            if (desktop && meta.isUserInteraction && sizes.workspace === 0) setPaneOpen(false);
          }}
        >
        <Panel id="conversation" defaultSize="45%" minSize={desktop ? '320px' : '0px'} className="flex h-full min-w-0 flex-col bg-conversation">
          <ConversationTabs>{prefs.view === 'brief' ? <Brief /> : prefs.view === 'now' ? <Now /> : prefs.view === 'scheduled' ? <Scheduled /> : prefs.view === 'memory' ? <Memory /> : thread ? <Thread key={thread.id} id={thread.id} /> : <Home />}</ConversationTabs>
        </Panel>
        {!remote && desktop && prefs.pane.open && <Separator aria-label="Resize conversation and workspace" className="w-px shrink-0 bg-border outline-offset-0 hover:bg-muted focus-visible:bg-ring" />}
        {!remote&&<Panel id="workspace" panelRef={workspace} defaultSize="55%" minSize={desktop ? '360px' : '0px'} collapsible collapsedSize="0px" className="h-full min-w-0">
          <Pane projectId={projectId} threadId={thread?.id} />
        </Panel>}
        </Group>
      </main>
    </div>
  );
}

function LeaveWorkspace(){
  const [busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
  return <><button type="button" className="underline" disabled={busy} onClick={()=>{setBusy(true);setError('');void window.backbone?.leaveRemoteWorkspace?.().catch(()=>setError('Sign-out could not be confirmed. Your session is kept. Check the connection before trying again.')).finally(()=>setBusy(false));}}>Leave workspace</button>{error&&<p role="alert">{error}</p>}</>;
}
export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
