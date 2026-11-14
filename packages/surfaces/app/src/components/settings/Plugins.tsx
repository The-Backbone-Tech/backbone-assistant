// Your plugins' commands, agents and hooks: from the Claude Code and Codex plugins you enabled, each shown
// under its plugin. Nothing is used until you enable it, and one whose text changes turns itself off until
// you look again. An enabled command is typed in the composer as /name; an enabled agent is a role an
// engine may give a child, which grants nothing. Hooks run commands on this computer, so they are listed
// and never run. A path a plugin declares outside its own folder is listed as refused, and nothing of it is read.
import type { PluginPart } from '@backbone-next/platform';
import * as React from 'react';
import { brand } from '../../brand';
import { call, onEvent } from '../../lib/api';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { SettingsRow } from './SettingsRow';

const KIND: Record<PluginPart['kind'], string> = { command: 'Command', agent: 'Agent', hook: 'Hook' };
const ORIGIN: Record<PluginPart['origin'], string> = { claude: 'Claude Code', codex: 'Codex' };

export function PluginsSection() {
  const [parts, setParts] = React.useState<PluginPart[]>();
  const load = React.useCallback(() => void call('plugins.parts', {}).then((ps) => setParts(ps ?? []), () => setParts([])), []);
  React.useEffect(() => {
    load();
    return onEvent((e) => e.topic === 'memory' && load());
  }, [load]);
  if (!parts) return <p className="py-4 text-sm text-muted">Loading…</p>;
  const plugins = [...new Set(parts.map((p) => p.plugin))];
  return (
    <div>
      <p className="pt-3 text-xs text-muted">
        Commands, agents and hooks of the Claude Code and Codex plugins you enabled. Each is off until you enable it, and a change to its file turns it off until you look again. A command you enable is typed in the composer as /name. An agent you enable is a role an engine may give a child; its tools give no permission. Hooks are never run.
      </p>
      {plugins.length === 0 && <p className="py-4 text-sm text-muted">No plugin commands, agents or hooks were found.</p>}
      {plugins.map((plugin) => (
        <section key={plugin} aria-label={plugin} className="pt-4">
          <h3 className="text-xs font-medium text-muted">{plugin} · {ORIGIN[parts.find((p) => p.plugin === plugin)!.origin]}</h3>
          {parts.filter((p) => p.plugin === plugin).map((p) => <PartRow key={p.id} part={p} onChange={load} />)}
        </section>
      ))}
    </div>
  );
}

function PartRow({ part, onChange }: { part: PluginPart; onChange: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const decide = async (verdict: 'enable' | 'disable') => {
    setBusy(true);
    setError(undefined);
    // Enabling names the version shown here; a file changed since is refused, and the list shows its new version.
    const r = await call('plugins.decide', { id: part.id, verdict, digest: part.digest });
    setBusy(false);
    if (!r.ok) setError(r.detail);
    onChange();
  };
  const title = (
    <span className="flex flex-wrap items-center gap-2">
      <span>{part.kind === 'command' && part.state !== 'refused' ? `/${part.name}` : part.name}</span>
      <Badge>{KIND[part.kind]}</Badge>
      {part.state === 'active' ? <Badge tone="committed">On</Badge> : part.state === 'not-run' ? <Badge tone="danger">Not run</Badge> : part.state === 'refused' ? <Badge tone="danger">Refused</Badge> : <Badge>Off</Badge>}
    </span>
  );
  const about = (
    <>
      {part.description && <span className="block">{part.description}{part.argumentHint ? ` Arguments: ${part.argumentHint}` : ''}</span>}
      {part.tools && part.tools.length > 0 && <span className="block">Declares tools: {part.tools.join(', ')}.</span>}
      {part.kind === 'hook' && part.state !== 'refused' ? <span className="block">Not run: hooks execute commands; {brand.name} does not run them</span> : part.note && <span className="block">{part.note}</span>}
      {part.blocked && <span className="block text-danger">{part.blocked}</span>}
      {error && <span role="alert" className="block text-danger">{error}</span>}
    </>
  );
  return (
    <div data-testid="plugin-part">
      <SettingsRow title={title} about={about}>
        {part.state === 'available' && !part.blocked && <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide('enable')}>Enable</Button>}
        {part.state === 'active' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('disable')}>Disable</Button>}
      </SettingsRow>
    </div>
  );
}
