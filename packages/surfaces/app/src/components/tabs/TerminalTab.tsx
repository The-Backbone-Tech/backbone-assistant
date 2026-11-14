// Terminal: a line-mode shell in the project's folder, run by the person on this computer.
import type { TerminalResult } from '@backbone-next/platform';
import * as React from 'react';
import { call } from '../../lib/api';
import { focusSoon } from '../../lib/utils';

export function TerminalTab({ projectId, active = true }: { projectId: string; active?: boolean }) {
  const [log, setLog] = React.useState<TerminalResult[]>([]);
  const [line, setLine] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const end = React.useRef<HTMLDivElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (active) return focusSoon(() => input.current); }, [active]);
  React.useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!line.trim() || busy) return;
    setBusy(true);
    const r = await call('terminal.run', { projectId, command: line });
    setLog((l) => [...l, r.ok ? r.value : { command: line, output: r.detail, code: null }]);
    setLine('');
    setBusy(false);
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
            {r.code !== 0 && <div className="text-danger">exit {r.code ?? 'timeout'}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => void run(e)} className="flex items-center gap-2 border-t border-border px-3 py-2 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring">
        <span className="text-muted" aria-hidden>
          $
        </span>
        <input ref={input} aria-label="Terminal command" value={line} disabled={busy} onChange={(e) => setLine(e.target.value)} className="flex-1 bg-transparent outline-none" />
      </form>
    </div>
  );
}
