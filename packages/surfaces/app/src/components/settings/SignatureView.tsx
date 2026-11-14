import type { ConnectorsView } from '@backbone-next/platform';
import * as React from 'react';
import { endConnectorSignature, signConnectorTool } from '../../lib/api';
import { signatureFailureMessage } from '../../lib/signed-tools';
import { Select } from '../ui/input';
import { SettingsRow } from './SettingsRow';

type ViewChoice = 'full' | 'custom';
const VIEW_KEY = 'signed-tools-view';
export function SignatureViewControl({ view, onChange }: { view?: ConnectorsView; onChange: () => void }) {
  const [choice, setChoice] = React.useState<ViewChoice>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'custom' ? 'custom' : 'full'; } catch { return 'full'; }
  });
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  React.useEffect(() => {
    if (!view || view.servers.some(server => server.blocked)) setMessage('');
  }, [view]);
  function save(next: ViewChoice) {
    if (next !== 'full' && next !== 'custom') return;
    setChoice(next);
    try { localStorage.setItem(VIEW_KEY, next); setMessage(''); }
    catch { setMessage('This view choice could not be saved in this browser.'); }
  }
  async function choose(serverId: string, tool: string, acts: boolean) {
    setBusy(true); setMessage('');
    try {
      const result = await (acts ? signConnectorTool(serverId, tool) : endConnectorSignature(serverId, tool));
      if (!result.ok) setMessage(result.detail);
    } catch (error) { setMessage(signatureFailureMessage(error, 'The tool choice could not be confirmed. Reload tool permissions to check its status.')); }
    finally { setBusy(false); onChange(); }
  }
  return <div className="border-b border-border pb-3">
    <SettingsRow title="How much runs without asking" about="Full and Custom apply the same rules today. Custom only shows the per-tool choices. This view choice is saved on this device.">
      <Select aria-label="How much runs without asking" value={choice} disabled={busy} onChange={(event) => save(event.target.value as ViewChoice)}>
        <option value="full">Full</option>
        <option value="balanced" disabled>Balanced — not available yet</option>
        <option value="strict" disabled>Strict — not available yet</option>
        <option value="custom">Custom</option>
      </Select>
    </SettingsRow>
    <p className="pt-2 text-xs text-muted">Balanced will ask before an outside write after an outside read in the same turn.</p>
    <p className="pt-1 text-xs text-muted">Strict will ask before every outside write.</p>
    {message && <p role="status" className="pt-2 text-xs text-muted">{message}</p>}
    {choice === 'custom' && view?.servers.flatMap((server) => server.tools.filter((tool) => tool.kind === 'effect' && tool.enabled && server.enabled).map((tool) => (
      <SettingsRow key={JSON.stringify([server.id, tool.name])} title={`${tool.name} · ${server.name}`} about={tool.description}>
        <Select aria-label={`Permission for ${tool.name} on ${server.name}`} value={tool.standing ? 'acts' : 'asks'} disabled={busy} onChange={(event) => void choose(server.id, tool.name, event.target.value === 'acts')}>
          <option value="asks">Ask me every time</option>
          <option value="acts" disabled={!server.egress || !window.backbone?.signConnectorTool}>Let it act without asking</option>
        </Select>
        {(!server.egress || !window.backbone?.signConnectorTool) && <span className="text-xs text-muted">To give permission, use the desktop app and allow sending for this connection first.</span>}
      </SettingsRow>
    )))}
  </div>;
}
