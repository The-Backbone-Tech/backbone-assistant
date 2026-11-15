// Terminal: a line-mode shell in the project's folder, run by the person on this computer.
import type { TerminalResult } from '@backbone-next/platform';
import * as React from 'react';
import { call } from '../../lib/api';
import { focusSoon } from '../../lib/utils';

/** `onBusy` tells the tab row a command is still running, so its tab can say so. */
export function TerminalTab({ projectId, active = true, onBusy }: { projectId: string; active?: boolean; onBusy?(busy: boolean): void }) {
  const [log, setLog] = React.useState<(TerminalResult & { refused?: boolean })[]>([]);
  const [line, setLine] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [unconfirmed, setUnconfirmed] = React.useState(false);
  const end = React.useRef<HTMLDivElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  React.useEffect(() => () => onBusy?.(false), [onBusy]);
  React.useEffect(() => { if (active) return focusSoon(() => input.current); }, [active]);
  React.useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!line.trim() || busy) return;
    setBusy(true); setUnconfirmed(false);
    try {
      const r = await call('terminal.run', { projectId, command: line });
      if (!r.ok && r.outcome === 'UNKNOWN') { setUnconfirmed(true); return; }
      setLog((l) => [...l, r.ok ? r.value : { command: line, output: r.detail, code: null, refused: true }]);
      setLine('');
    } catch {
      setUnconfirmed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-sunken font-mono text-xs" data-testid="terminal-tab">
      <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
        {log.map((r, i) => (
          <div key={i} className="mb-2">
            <div>
              <span className="text-muted">$</span> {r.command}
            </div>
            <pre className="whitespace-pre-wrap text-fg">{r.output}</pre>
            {!r.refused && r.code !== 0 && <div className="text-danger">exit {r.code ?? 'timeout'}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      {unconfirmed && <p role="alert" className="border-t border-border px-3 py-2 text-danger">The command's outcome is unconfirmed. It may have run; check before running it again.</p>}
      <form onSubmit={(e) => void run(e)} className="flex items-center gap-2 border-t border-border px-3 py-2 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring">
        <span className="text-muted" aria-hidden>
          $
        </span>
        <input ref={input} aria-label="Terminal command" value={line} disabled={busy} onChange={(e) => setLine(e.target.value)} className="flex-1 bg-transparent outline-none" />
      </form>
    </div>
  );
}
