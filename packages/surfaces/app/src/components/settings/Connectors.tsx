// Your connected tools: the MCP servers in your own configs (Claude Code, Claude Desktop, Codex,
// Cursor, and this app's own list), offered to every engine through one crossing. Nothing is on until
// you turn it on, after seeing its tools. Each tool reads or changes things: a read flows and says how
// complete it is; a change is held here for you, on its exact words, and sent only through a door you open.
import type { ConnectorServer, ConnectorTool } from '@backbone-next/platform';
import * as React from 'react';
import { call, enableConnector, enableConnectorTools, endConnectorSignature, markConnectorToolRead, openConnectorDoor, signConnectorTool } from '../../lib/api';
import { connectorRefusal, type CONNECTOR_CANCEL } from '../../lib/connector-cancel';
import { signatureFailureMessage } from '../../lib/signed-tools';
import { HeldCalls } from './HeldCalls';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Select } from '../ui/input';
import { SettingsRow } from './SettingsRow';
import { ConnectorCatalogue } from './ConnectorCatalogue';
import { useSettingsRead } from '../../lib/use-settings-read';
import { SettingsReadStatus } from './SettingsReadStatus';

const readConnectors = () => call('connectors.list', {});

export function ConnectorsSection() {
  const { value: view, pending, failed, reload: load } = useSettingsRead(readConnectors, 'connectors');
  const status = <SettingsReadStatus label="Connected tools" pending={pending} failed={failed} hasValue={view !== undefined} retry={load} />;
  if (!view) return status;
  const waiting = view.held.filter((h) => h.state === 'waiting');
  return (
    <div>
      {status}
      <fieldset aria-label="Connected tools">
      <ConnectorCatalogue servers={view.servers} onChange={load} />
      <p className="pt-3 text-xs text-muted">
        Tools start off. Turning on a server or tool is confirmed in the desktop app. Reads run for every engine. Held actions wait for your permission for one call or for the tool to act without asking. Allow sending before giving either permission. An unknown outcome pauses that tool’s permission until you resolve it.
      </p>
      {waiting.length > 0 && <HeldCalls held={waiting} onChange={load} />}
      {view.servers.length === 0 && <p className="py-4 text-sm text-muted">No MCP servers were found in your configs.</p>}
      {view.servers.map((s) => (
        <ServerRow key={s.id} server={s} onChange={load} pausedTools={[...new Set(view.held.filter(h => h.serverId === s.id && h.state === 'unknown').map(h => h.tool))]} />
      ))}
      </fieldset>
      <HeldCalls held={view.held.filter(h => h.state === 'unknown')} onChange={load} unknown />
      <HeldCalls held={view.held.filter(h => h.state !== 'waiting' && h.state !== 'unknown').slice(0, 10)} onChange={load} past />
    </div>
  );
}

function stateOf(s: ConnectorServer): { label: string; tone: 'neutral' | 'committed' | 'pending' | 'danger' } {
  if (s.blocked) return { label: 'Blocked', tone: 'danger' };
  if (s.problem) return { label: 'Needs attention', tone: 'danger' };
  if (s.changed) return { label: 'Changed', tone: 'pending' };
  return s.enabled ? { label: 'On', tone: 'committed' } : { label: 'Off', tone: 'neutral' };
}

function ServerRow({ server, onChange, pausedTools }: { server: ConnectorServer; onChange: () => void; pausedTools: string[] }) {
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const state = stateOf(server);
  async function act(run: () => Promise<{ ok: boolean; detail?: string; reason?: string; outcome?: string }>, action?: keyof typeof CONNECTOR_CANCEL) {
    setBusy(true);
    setError(undefined);
    try {
      const r = await run();
      setError(connectorRefusal(r, action));
    } catch { setError('This could not be changed just now. Try again.'); }
    finally { setBusy(false); onChange(); }
  }
  const listed = !!server.listedAt;
  return (
    <div data-testid={`connector-${server.id}`}>
      <SettingsRow
        title={<span className="inline-flex items-center gap-2">{server.name} <Badge tone={state.tone}>{state.label}</Badge></span>}
        about={
          <>
            From {server.source} · <span className="font-mono">{server.shown}</span>
            {server.envNames.length > 0 && <span className="block">Uses {server.envNames.join(', ')} from that config; their values stay there.</span>}
            {server.changed && <span className="block">It starts differently than when you turned it on, so it is off until you turn it on again.</span>}
            {server.problem && <span className="block">{server.problem}</span>}
            {server.blocked && <span className="block">{server.blocked}</span>}
          </>
        }
      >
        <Button variant="outline" size="sm" disabled={busy || !!server.blocked || (!!server.plugin && !server.enabled)} title={server.plugin && !server.enabled ? 'A plugin\'s server runs its command only once you turn it on.' : undefined} onClick={() => void act(async () => { const r = await call('connectors.refresh', { serverId: server.id }); setOpen(true); return r; })}>
          {server.plugin && !server.enabled ? 'Enable to list its tools' : listed ? 'List again' : 'List tools'}
        </Button>
        {listed && (
          <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide tools' : `Tools (${server.tools.filter((t) => t.enabled).length}/${server.tools.length})`}
          </Button>
        )}
        {(listed || (server.plugin && !server.blocked)) && (
          <Button size="sm" variant={server.enabled ? 'outline' : 'default'} disabled={busy} aria-label={`${server.enabled ? 'Turn off' : 'Turn on'} ${server.name}`} onClick={() => void act(() => server.enabled ? call('connectors.set', { serverId: server.id, enabled: false }) : enableConnector(server.id), server.enabled ? undefined : 'enable')}>
            {server.enabled ? 'Turn off' : 'Turn on'}
          </Button>
        )}
        {listed && server.enabled && server.tools.some((t) => !t.enabled) && (
          <Button size="sm" variant="outline" disabled={busy} title="Review up to 8 off tools in one native question. More tools stay off until you review the next group." onClick={() => void act(() => enableConnectorTools(server.id), 'enable')}>
            Turn on its tools
          </Button>
        )}
        {listed && server.enabled && (
          <Button size="sm" variant="outline" disabled={busy} title="When open, a change you permit here is sent to this server, once, and a tool you permit acts without asking. You can permit one exact call, including a send." onClick={() => void act(() => (server.egress ? call('connectors.set', { serverId: server.id, egress: false }) : openConnectorDoor(server.id)), server.egress ? undefined : 'open')}>
            {server.egress ? 'Close sending' : 'Allow sending'}
          </Button>
        )}
      </SettingsRow>
      {pausedTools.map(tool => <p key={tool} role="status" className="pb-3 text-xs text-muted">{tool} is paused: an earlier call has an unknown outcome. Its permission allows no more calls to this tool until you resolve it. Other tools and your one-call permissions remain available.</p>)}
      {error && <p className="pb-3 text-xs text-danger">{error}</p>}
      {open && listed && (
        <div className="border-b border-border pb-2 pl-4">
          {server.tools.map((t) => (
            <ToolLine key={t.name} serverId={server.id} door={server.enabled && server.egress} paused={pausedTools.includes(t.name)} tool={t} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

const ANNOTATED: Record<ConnectorTool['annotated'], string> = {
  read: 'The server says it only reads.',
  effect: 'The server says it can change things.',
  unannotated: 'The server does not say what it does, so it counts as a change.',
};

function ToolLine({ serverId, door, tool, onChange, paused }: { serverId: string; door: boolean; paused: boolean; tool: ConnectorTool; onChange: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  // Signing is asked in main; ending a signature only takes authority away, so the api does it.
  const standing = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await (tool.standing ? endConnectorSignature(serverId, tool.name) : signConnectorTool(serverId, tool.name));
      setError(connectorRefusal(r, tool.standing ? undefined : 'sign'));
    } catch (error) {
      setError(signatureFailureMessage(error, 'The tool choice could not be confirmed. Reload to check its status.'));
    } finally { setBusy(false); onChange(); }
  };
  const set = async (patch: { enabled?: boolean; override?: 'read' | 'effect' | null }) => {
    setBusy(true);
    setError(undefined);
    try {
      const reads = patch.override === 'read' || (patch.override === null && tool.annotated === 'read');
      const r = await (patch.enabled === true ? enableConnector(serverId, tool.name)
        : reads ? markConnectorToolRead(serverId, tool.name, patch.override === null)
          : call('connectors.set', { serverId, tool: { name: tool.name, ...patch } }));
      setError(connectorRefusal(r, patch.enabled === true ? 'enable' : reads ? 'read' : undefined));
    } catch { setError('This could not be changed just now. Try again.'); }
    finally { setBusy(false); onChange(); }
  };
  return (
    <SettingsRow
      className="py-2.5"
      title={<span className="inline-flex items-center gap-2 font-mono text-xs">{tool.name} <Badge tone={tool.kind === 'read' || tool.standing ? 'neutral' : 'pending'}>{tool.kind === 'read' ? 'Reads' : tool.standing && paused ? 'Changes things: paused' : tool.standing ? 'Changes things: without asking' : 'Changes things: held'}</Badge></span>}
      about={
        <>
          {tool.description}
          <span className="block">{ANNOTATED[tool.annotated]}{tool.override ? ' You set what it is.' : ''}</span>
          {tool.changed && <span className="block">It changed since you turned it on, so it is off until you turn it on again.</span>}
          {tool.standing && <span className="block">You permitted it to act without asking. Each call is recorded below with its outcome.</span>}
          {error && <span className="block text-danger">{error}</span>}
        </>
      }
    >
      <Select size="sm" aria-label={`What ${tool.name} does`} disabled={busy} value={tool.override ?? 'auto'} onChange={(e) => void set({ override: e.target.value === 'auto' ? null : (e.target.value as 'read' | 'effect') })}>
        <option value="auto">As the server says</option>
        <option value="read">Only reads</option>
        <option value="effect">Changes things</option>
      </Select>
      {tool.kind === 'effect' && tool.enabled && (
        <Button size="sm" variant="outline" disabled={busy || (!door && !tool.standing)} title={door || tool.standing ? 'One permission for this tool: its calls then go out without asking you each time, while the tool and the server are exactly as permitted. Turning either off, closing sending or ending it here ends it.' : 'Allow sending to this server first.'} onClick={() => void standing()}>
          {tool.standing ? 'Ask me every time' : 'Let it act without asking'}
        </Button>
      )}
      <Button size="sm" variant={tool.enabled ? 'outline' : 'default'} disabled={busy} aria-label={`${tool.enabled ? 'Turn off' : 'Turn on'} ${tool.name}`} onClick={() => void set({ enabled: !tool.enabled })}>
        {tool.enabled ? 'Turn off' : 'Turn on'}
      </Button>
    </SettingsRow>
  );
}
