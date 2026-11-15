// Work belongs to the platform. Mounting, hiding and closing this view dispatch no process effects.
import type { TerminalBlock, TerminalView } from '@backbone-next/platform';
import * as React from 'react';
import { call, clientKey, onEvent } from '../../lib/api';
import { focusSoon } from '../../lib/utils';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tip } from '../ui/tooltip';
import { useTerminalFocus } from './terminal-focus';

export function TerminalTab({ projectId, active = true, onBusy }: { projectId: string; active?: boolean; onBusy?(busy: boolean): void }) {
  useTerminalFocus(active);
  const [view, setView] = React.useState<TerminalView>();
  const [line, setLine] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [pending, setPending] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [details, setDetails] = React.useState(() => { try { return localStorage.getItem('terminal-details-seen') !== 'yes'; } catch { return true; } });
  const detailsId = React.useId();
  React.useEffect(() => { if (active) try { localStorage.setItem('terminal-details-seen', 'yes'); } catch { /* The notes remain reachable without storage. */ } }, [active]);
  const [uncertain, setUncertain] = React.useState<{ commands: TerminalBlock[]; omitted: number }>({ commands: [], omitted: 0 });
  const uncertainKeys = React.useRef(new Set<string>());
  const input = React.useRef<HTMLInputElement>(null);
  const end = React.useRef<HTMLDivElement>(null), follow = React.useRef(true);
  const history = React.useRef<{ index: number; draft: string }>({ index: -1, draft: '' });
  const owner = React.useRef(0), sequence = React.useRef(0), submitting = React.useRef(false);
  const refreshing = React.useRef<number | undefined>(undefined), readFailed = React.useRef(false);
  const running = view?.commands.find(b => b.status === 'running');
  const busy = !!running || pending;
  React.useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  React.useEffect(() => () => onBusy?.(false), [onBusy]);
  // The command line takes the keyboard when the tab is shown, and again once loading lets it. It never takes it
  // from a control that received focus in between (the surviving tab after "Close other tabs").
  const focusAtShow = React.useRef<Element | null>(null);
  React.useEffect(() => { if (active) focusAtShow.current = document.activeElement; }, [active]);
  React.useEffect(() => {
    if (!active) return;
    if (document.activeElement !== focusAtShow.current && document.activeElement !== document.body) return;
    const stop = focusSoon(() => input.current);
    return stop;
  }, [active, loading]);
  async function refresh(epoch: number) {
    if (refreshing.current === epoch) return;
    refreshing.current = epoch;
    const order = ++sequence.current;
    try {
      const r = await call('terminal.list', { projectId });
      if (owner.current !== epoch || sequence.current !== order) return;
      if (r.ok) {
        setView(r.value);
        if (readFailed.current && !uncertainKeys.current.size) setNotice('');
        readFailed.current = false;
        const recovered = r.value.commands.filter(b => uncertainKeys.current.has(b.clientKey)).map(b => b.clientKey);
        if (recovered.length) { recovered.forEach(key => uncertainKeys.current.delete(key)); setUncertain(old => ({ ...old, commands: old.commands.filter(b => !recovered.includes(b.clientKey)) })); setNotice(''); }
      }
      else setNotice(r.detail);
    } catch { if (owner.current === epoch) { readFailed.current = true; setNotice(old => uncertainKeys.current.size ? old : 'Could not read commands. Check again to see what happened; nothing will run again automatically.'); } }
    finally { if (refreshing.current === epoch) refreshing.current = undefined; if (owner.current === epoch) setLoading(false); }
  }
  React.useEffect(() => {
    const epoch = ++owner.current;
    submitting.current = false; setPending(false); history.current = { index: -1, draft: '' }; readFailed.current = false;
    uncertainKeys.current.clear(); setView(undefined); setLoading(true); setNotice(''); setLine(''); setUncertain({ commands: [], omitted: 0 });
    return () => { owner.current++; };
  }, [projectId]);
  React.useEffect(() => {
    if (!active) return;
    void refresh(owner.current);
    // A mounted hidden tab owns no polling. Lost replies are checked explicitly, never resent.
    if (running) {
      const timer = setInterval(() => void refresh(owner.current), 250);
      return () => clearInterval(timer);
    }
  }, [active, projectId, running?.id]);
  // A hidden tab does not poll, but its tab still says "running": it reads once when the platform says this
  // project's command changed (it ended, or Stop was answered).
  React.useEffect(() => {
    if (active || !running) return;
    return onEvent((event) => { if (event.topic === 'material' && event.id === projectId) void refresh(owner.current); });
  }, [active, projectId, running?.id]);
  React.useEffect(() => { if (active && follow.current) end.current?.scrollIntoView({ block: 'end' }); }, [view, active]);

  async function run(command: string) {
    if (!command.trim() || submitting.current) return;
    if (running) { setNotice('A command is already running in this project. Stop it or wait for it to finish.'); return; }
    const epoch = owner.current, id = `${view?.historyKey}:${clientKey()}`;
    follow.current = true; submitting.current = true; setPending(true); setNotice('');
    const unknown = () => {
      uncertainKeys.current.add(id);
      setUncertain(old => ({ commands: [...old.commands, { id, clientKey: id, command, output: '', code: null, status: 'not-known' as const, cwd: view?.cwd ?? '', startedAt: new Date().toISOString(), signals: [], omittedBytes: 0, omittedLines: 0, detail: 'The command’s outcome is unconfirmed. It may have run. Check again; it will not run again automatically.' }].slice(-50), omitted: old.omitted + Math.max(0, old.commands.length + 1 - 50) }));
      setNotice('The command’s outcome is unconfirmed. It may have run. Check again; it will not run again automatically.');
    };
    try {
      const r = await call('terminal.start', { projectId, command, clientKey: id });
      if (owner.current !== epoch) return;
      if (r.ok) {
        setView(v => ({ cwd: r.value.cwd, historyKey: v?.historyKey, omittedCommands: v?.omittedCommands ?? 0, commands: [...(v?.commands ?? []).filter(b => b.id !== r.value.id), r.value] }));
        setLine(old => old === command ? '' : old); history.current.index = -1;
      } else if (r.outcome === 'UNKNOWN') unknown(); else setNotice(r.detail);
    } catch { if (owner.current === epoch) unknown(); }
    finally {
      if (owner.current === epoch) { submitting.current = false; setPending(false); void refresh(epoch); }
    }
  }
  async function stop() {
    if (!running || running.stopping) return;
    setNotice('');
    const epoch = owner.current;
    try {
      const r = await call('terminal.stop', { projectId, id: running.id });
      if (owner.current !== epoch) return;
      if (!r.ok) setNotice(r.detail);
      await refresh(epoch);
    } catch { if (owner.current === epoch) setNotice('Stop could not be confirmed. Check again to see what happened.'); }
  }
  async function clear() {
    const epoch = owner.current;
    try {
      const r = await call('terminal.clear', { projectId });
      if (owner.current !== epoch) return;
      if (r.ok) { setView(r.value); setNotice(''); uncertainKeys.current.clear(); setUncertain({ commands: [], omitted: 0 }); history.current.index = -1; }
      else setNotice(r.detail);
    } catch { if (owner.current === epoch) setNotice('Terminal history could not be cleared. Check again before trying to clear it.'); }
  }
  const unreadable = notice.includes('terminal record') && notice.includes('cannot be read');
  const allBlocks = [...(view?.commands ?? []), ...uncertain.commands].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const blocks = allBlocks.slice(-50), omitted = (view?.omittedCommands ?? 0) + uncertain.omitted + Math.max(0, allBlocks.length - 50);
  return (
    <div className="flex h-full min-w-0 flex-col bg-sunken font-mono text-xs" data-testid="terminal-tab" onKeyDown={e => {
      if (!e.ctrlKey || e.key.toLowerCase() !== 'c') return;
      const selected = e.target instanceof HTMLInputElement
        ? e.target.value.slice(e.target.selectionStart ?? 0, e.target.selectionEnd ?? 0)
        : window.getSelection()?.toString();
      if (selected && navigator.clipboard?.writeText) {
        e.preventDefault();
        void navigator.clipboard.writeText(selected).catch(() => setNotice('Selected text could not be copied. Use the system Copy command.'));
      } else if (!selected && running) { e.preventDefault(); void stop(); }
    }}>
      <div className="border-b border-border px-3 py-2 text-muted">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 flex-1 truncate" title={view?.cwd}>Folder: {view?.cwd ?? (loading ? 'Loading…' : 'Not available')}</p>
          <Button variant="ghost" size="sm" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(!details)}>Terminal details</Button>
        </div>
        {details && <div id={detailsId}>
          <p>Interactive programs are not supported yet. Standard input is closed. Programs that create a separate process group can outlive Stop.</p>
          <p>Recent commands and output are kept in the data folder. Arrow keys recall them, including commands with an unknown outcome.</p>
          <Button variant="ghost" size="sm" onClick={() => setClearing(true)}>Clear terminal history</Button>
        </div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="Command history" onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; }}>
        {loading && <p role="status">Loading commands…</p>}
        {omitted ? <p className="mb-2 text-muted">{omitted} earlier commands left out. Keeping the latest 50.</p> : null}
        {!loading && view && !blocks.length && <p className="text-muted">Run a command in this project’s folder.</p>}
        {blocks.map(b => (
          <section key={b.id} className="mb-3 border-b border-border pb-3" aria-label={`Command: ${b.command}`} data-testid="terminal-block">
            <div className="break-all"><span className="text-muted" aria-hidden>$ </span>{b.command}</div>
            <pre className="whitespace-pre-wrap break-words text-fg">{b.output}</pre>
            {(b.omittedBytes > 0 || b.omittedLines > 0) && <p className="text-muted">{b.omittedBytes} output bytes and {b.omittedLines} line breaks left out of the middle. Showing the beginning and end; at most 65,536 displayed bytes and 1,000 line breaks.</p>}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span role="status" className={b.status === 'failed' || b.status === 'not-known' ? 'text-danger' : 'text-muted'}>
                {b.status === 'running' ? b.stopping ? 'Stopping…' : 'Running…' : b.status === 'succeeded' ? '✓ Succeeded' : b.status === 'not-known' ? '? Not known' : `× Failed — ${b.detail ?? `exit ${b.code}`}`}
              </span>
              {(b.status === 'succeeded' || b.status === 'failed') && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(b.command)}>Run again</Button>}
              {b.status === 'running' && <Tip label="Stop: interrupt the process group, wait 1 second, terminate, wait 1 second, then kill. Allow 1 second to confirm. Programs that create a separate process group can outlive Stop." shortcut="Ctrl+C"><Button variant="danger" size="sm" disabled={b.stopping} onClick={() => void stop()}>Stop</Button></Tip>}
            </div>
            {(b.status === 'not-known' || b.status === 'running' && b.detail) && <p className="mt-1 text-muted">{b.detail ?? 'The outcome could not be confirmed. This command is never retried automatically.'}</p>}
            {b.saveError && <p className="mt-1 text-danger">{b.saveError}</p>}
          </section>
        ))}
        <div ref={end} />
      </div>
      {notice && <div role="alert" className="border-t border-border px-3 py-2 text-danger">{notice} <Button variant="ghost" size="sm" onClick={() => { setNotice(''); void refresh(owner.current); }}>Check again</Button></div>}
      <ConfirmDialog open={clearing} onOpenChange={setClearing} title="Clear terminal history?" consequence={unreadable ? 'This replaces the unreadable terminal record. A command left from before a crash can no longer be stopped from here.' : 'This permanently removes finished command blocks and their output for this project; running commands are kept.'} action="Clear terminal history" onConfirm={clear} restoreFocus={() => input.current} />
      <form onSubmit={e => { e.preventDefault(); void run(line); }} className="flex items-center gap-2 border-t border-border px-3 py-2 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring">
        <span className="text-muted" aria-hidden>$</span>
        <input ref={input} aria-label="Terminal command" value={line} disabled={loading || pending || !view} onChange={e => { setLine(e.target.value); history.current.index = -1; }} onKeyDown={e => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const commands = view?.commands ?? [], h = history.current;
          if (h.index === -1) h.draft = line;
          h.index = e.key === 'ArrowUp' ? Math.min(h.index + 1, commands.length - 1) : Math.max(-1, h.index - 1);
          setLine(h.index === -1 ? h.draft : commands[commands.length - 1 - h.index]?.command ?? h.draft);
        }} className="min-w-0 flex-1 bg-transparent outline-none" />
        <Button size="sm" type="submit" disabled={loading || pending || !line.trim() || !view}>Run</Button>
      </form>
    </div>
  );
}
