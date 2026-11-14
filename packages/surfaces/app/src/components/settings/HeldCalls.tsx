import type { HeldCall } from '@backbone-next/platform';
import * as React from 'react';
import { call, releaseConnectorCall, resolveConnectorEffect } from '../../lib/api';
import { attachmentDisplay } from '../../lib/connector-attachments';
import { HeldAttachments } from './HeldAttachments';
import { exactText } from '../../lib/connector-call';
import { connectorRefusal } from '../../lib/connector-cancel';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { SettingsRow } from './SettingsRow';

export function HeldCalls({ held, onChange, past = false, unknown = false }: { held: HeldCall[]; onChange(): void; past?: boolean; unknown?: boolean }) {
  const [busy, setBusy] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  async function decide(h: HeldCall, action: 'release' | 'discard' | 'resolve') {
    setBusy(h.effect); setError(undefined);
    try {
      const result = await (action === 'resolve' ? resolveConnectorEffect(h.effect, h.argsHash) : action === 'release'
        ? releaseConnectorCall(h.effect, h.argsHash) : call('connectors.decide', { effect: h.effect, argsHash: h.argsHash, verdict: 'discard' }));
      setError(connectorRefusal(result, action === 'discard' ? undefined : action));
    } catch { setError('This decision could not be confirmed. Inspect the receipt before trying again.'); }
    finally { setBusy(undefined); onChange(); }
  }
  if (!held.length) return null;
  return <div className="mt-3 min-w-0" data-testid={unknown ? 'connectors-unknown' : past ? 'connectors-decided' : 'connectors-held'}>
    <div className="text-xs font-medium text-muted">{unknown ? 'Unknown outcomes: inspect these calls' : past ? 'Decided' : 'Held actions'}</div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {held.map(h => { const shown = attachmentDisplay(h); return <div key={h.effect} data-testid={`connector-call-${h.effect}`} className="min-w-0 [overflow-wrap:anywhere]">
      <SettingsRow title={<span className="text-xs">{h.serverName}: {h.tool}</span>} about={<>
        <span className="block whitespace-pre-wrap font-mono">{shown.files.length ? 'Statement (attachment metadata): ' : 'Exact statement: '}{exactText(shown.statement)}</span>
        <span className="block whitespace-pre-wrap font-mono">{shown.files.length ? 'Arguments (attachment metadata): ' : 'Arguments: '}{exactText(shown.args)}</span>
        <HeldAttachments files={shown.files} />
        {shown.files.length > 0 && <span className="block font-mono">Exact call hash: {h.argsHash}</span>}
        <span className="block">{h.detail}{h.standing ? ' Sent with your permission.' : ''}</span>
        <span className="block">Core dispatch admitted: {h.dispatchedAt ? <time dateTime={h.dispatchedAt}>{new Date(h.dispatchedAt).toLocaleString()}</time> : 'Not available.'} This is not proof of delivery.</span>
        <span className="block">Permission: {h.standingSignatureId ?? (h.personReleasedAt ? 'Your permission for this one call.' : 'Not available.')}</span>
        {h.dispatchReceipt && <span className="block font-mono">Dispatch receipt: {h.dispatchReceipt.seq} · {h.dispatchReceipt.hash}</span>}
        <span className="block font-mono">Call receipt: {h.effect}</span>
        {unknown && <span className="block">{h.tool} stays paused for automatic sending until you resolve every unknown for this tool on this connection. Reads, other tools and your one-call permissions remain available.</span>}
        {h.resolution && <span className="block">Inspection {h.resolution.state}: {h.resolution.answer === 'happened' ? 'It did happen.' : h.resolution.answer === 'did_not_happen' ? 'It did not happen.' : 'I do not know; keep it closed.'} Receipt: {h.resolution.id}{h.resolution.ledger ? ` · Core receipt ${h.resolution.ledger.seq}` : ''}</span>}
      </>}>
        <Badge tone={unknown ? 'pending' : 'neutral'}>{({ released: 'Permitted, not sent', discarded: 'Discarded', sent: 'Sent', failed: 'Not done', unknown: 'Unknown outcome', waiting: 'Waiting' } as const)[h.state]}</Badge>
        {unknown ? <Button size="sm" disabled={busy === h.effect} onClick={() => void decide(h, 'resolve')}>Resolve outcome</Button> : !past && <>
          <Button size="sm" variant="outline" disabled={busy === h.effect} onClick={() => void decide(h, 'discard')}>Discard</Button>
          <Button size="sm" disabled={busy === h.effect} onClick={() => void decide(h, 'release')}>Permit</Button>
        </>}
      </SettingsRow>
    </div>; })}
  </div>;
}
