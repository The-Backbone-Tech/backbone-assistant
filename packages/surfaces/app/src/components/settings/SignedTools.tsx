import type { StandingSignatureStatus } from '@backbone-next/platform';
import * as React from 'react';
import { call, endConnectorSignature, onEvent } from '../../lib/api';
import { endSignature, signedTools, signatureEndState, localTime, signatureFailureMessage, visibleRetainedTools, type SignatureEndState, type SignatureListing, type SignedToolRow } from '../../lib/signed-tools';
import { SignatureViewControl } from './SignatureView';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

export function SignedToolsSection() {
  const [view, setView] = React.useState<SignatureListing>();
  const [coreStatus, setCoreStatus] = React.useState<StandingSignatureStatus>();
  const [error, setError] = React.useState<string>();
  const [ended, setEnded] = React.useState<SignedToolRow[]>([]);
  const [unconfirmed, setUnconfirmed] = React.useState<SignedToolRow[]>([]);
  const [busy, setBusy] = React.useState<string>();
  const request = React.useRef(0);
  const load = React.useCallback(async (clearError = false) => {
    const id = ++request.current;
    try {
      const [next, status] = await Promise.all([call('connectors.list', {}), call('core.signatureStatus', {}).catch(() => undefined)]);
      if (id === request.current) {
        setView(next); setCoreStatus(status);
        if (clearError || next.servers.some(server => server.blocked)) setError(undefined);
        const active = signedTools(next);
        setEnded(prior => visibleRetainedTools(next, prior));
        setUnconfirmed(prior => visibleRetainedTools(next, prior).filter(row => !active.some(current => current.key === row.key)));
      }
    } catch {
      if (id === request.current) { setView(undefined); setError('Tool permissions could not be loaded. Try again.'); }
    }
  }, []);
  React.useEffect(() => {
    void load();
    const off = onEvent((event) => { if (event.topic === 'connectors') void load(); });
    return () => { off(); request.current++; };
  }, [load]);
  async function end(row: SignedToolRow) {
    setBusy(row.key);
    setError(undefined);
    try {
      const result = await endSignature((_method, args) => endConnectorSignature(args.serverId, args.tool.name), row);
      if (result.ok) {
        // Keep the acknowledgement until a newer listing withholds the tool.
        const endedValue = result.value;
        setView(prior => prior && { ...prior, servers: prior.servers.map(server => server.id !== row.server.id ? server : 'tools' in endedValue ? endedValue : { ...server, tools: server.tools.map(tool => tool.name === row.tool.name ? { ...tool, standing: undefined } : tool) }) });
        setUnconfirmed(prior => prior.filter(item => item.key !== row.key));
        setEnded((prior) => [...prior.filter((item) => item.key !== row.key), row]);
        await load();
      } else setError(result.detail);
    } catch (error) {
      request.current++;
      setUnconfirmed(prior => [...prior.filter(item => item.key !== row.key), row]);
      setError(signatureFailureMessage(error, 'The end request could not be confirmed. Reload to check its current status.'));
    } finally { setBusy(undefined); }
  }
  const active = view ? signedTools(view) : [];
  const rows = [...active, ...visibleRetainedTools(view, unconfirmed).filter(row => !active.some(current => current.key === row.key))];
  return <div className="min-w-0">
    <SignatureViewControl view={view} onChange={() => void load()} />
    {view && coreStatus?.state !== 'verified' && <p role="status" className="pt-3 text-xs text-muted">{coreStatus?.state === 'paused' ? 'Paused: Core refuses calls under these permissions. You can still permit individual calls yourself.' : 'Permission status could not be checked. Whether calls can run without asking is not available yet.'}</p>}
    <p className="pt-3 text-xs text-muted">Permitted tools act without asking while the tool and connection stay as permitted and Core has verified its permission records. End a permission here to stop it locally.</p>
    {error && <div role="alert" className="py-3 text-xs text-danger">{error} <Button size="sm" variant="outline" onClick={() => void load(true)}>Reload tool permissions</Button></div>}
    {!view && !error && <p className="py-4 text-sm text-muted">Loading…</p>}
    {view && rows.length === 0 && <p className="py-4 text-sm text-muted">No active permissions.</p>}
    {rows.map((row) => <SignatureRow key={row.key} row={row} busy={!!busy} onEnd={() => void end(row)} paused={coreStatus?.state !== 'verified' || !!row.unknowns} statusKnown={!!coreStatus} unconfirmed={unconfirmed.some(item => item.key === row.key)} onReload={() => void load(true)} />)}
    {visibleRetainedTools(view, ended).map((row) => <SignatureRow key={`ended:${row.key}`} row={row} ended={signatureEndState(view, row)} />)}
  </div>;
}

function SignatureRow({ row, ended, busy, onEnd, paused, statusKnown, unconfirmed, onReload }: { row: SignedToolRow; ended?: SignatureEndState; busy?: boolean; onEnd?: () => void; paused?: boolean; statusKnown?: boolean; unconfirmed?: boolean; onReload?: () => void }) {
  const { server, tool, last } = row;
  return <article aria-label={`${tool.name} on ${server.name}`} className="min-w-0 border-b border-border py-4 text-xs leading-5 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-center gap-2 text-ui font-medium">
      <span>{tool.name} · {server.name}</span><Badge tone={ended || paused || unconfirmed ? 'neutral' : 'committed'}>{unconfirmed ? 'End not confirmed' : ended === 'pending' ? 'Ending pending in Core' : ended === 'conflict' ? 'Conflict' : ended === 'ended' ? 'Ended' : ended ? 'Ended locally' : paused ? (statusKnown ? 'Paused' : 'Status unavailable') : 'Acts without asking'}</Badge>
      {!ended && <Button className="ml-auto border-danger text-danger" size="sm" variant="outline" disabled={busy} onClick={onEnd}>{unconfirmed ? 'End again' : 'End permission'}</Button>}
    </div>
    {!!row.unknowns && <p className="mt-2 text-muted">{tool.name} has an unresolved unknown outcome on this connection. Inspect it in Connected tools; ending or giving permission does not resolve it.</p>}
    <dl className="mt-2 grid gap-1 text-muted">
      <div><dt className="inline font-medium">Connection: </dt><dd className="inline">{server.source} · {server.shown}</dd></div>
      <div><dt className="inline font-medium">Permitted: </dt><dd className="inline"><time dateTime={row.at}>{localTime(row.at)}</time></dd></div>
      <div><dt className="inline font-medium">Description shown when permitted: </dt><dd className="inline whitespace-pre-wrap">{tool.description || 'No description was shown.'}</dd></div>
      <div><dt className="inline font-medium">Permission: </dt><dd className="inline">One permission for this tool. Older permissions retain the scope you originally allowed; a call outside it waits for your permission for that call or a new tool permission.</dd></div>
      <div><dt className="inline font-medium">Offline ending: </dt><dd className="inline">Local removal is available; pending Core confirmation is shown separately.</dd></div>
      <div><dt className="inline font-medium">Permission ID: </dt><dd className="inline">{row.id ?? 'Not available yet.'}</dd></div>
      <div><dt className="inline font-medium">Full permitted definition: </dt><dd className="inline">Not available yet.</dd></div>
      <div><dt className="inline font-medium">Calls sent under this permission: </dt><dd data-testid="permission-call-count" className="inline">{row.id ? row.calls : 'Not available yet. The record does not identify individual permissions.'}</dd></div>
      {!row.id && <div><dt className="inline font-medium">Recorded calls under permissions for this tool: </dt><dd className="inline">{row.calls} across all its permissions.</dd></div>}
      <div><dt className="inline font-medium">Last receipt for this permission: </dt><dd className="inline">{row.id ? last ? `${last.state === 'unknown' ? 'Unknown outcome' : last.state === 'failed' ? 'Not done' : 'Sent'} · ${localTime(last.dispatchedAt ?? last.at)} · ${last.effect} · ${last.detail}` : 'No sent calls recorded.' : 'Not available yet.'}</dd></div>
      {!row.id && <div><dt className="inline font-medium">Latest recorded receipt for this tool under any permission: </dt><dd className="inline">{last ? `${last.state === 'unknown' ? 'Unknown outcome' : last.state === 'failed' ? 'Not done' : 'Sent'} · ${localTime(last.at)} · ${last.effect} · ${last.detail}` : 'No sent calls recorded.'}</dd></div>}
    </dl>
    {unconfirmed && <p role="status" className="mt-2 text-muted">The end request is not confirmed. <Button size="sm" variant="outline" onClick={onReload}>Check permission status</Button></p>}
    {ended && <p role="status" className="mt-2 text-muted">{ended === 'ended' ? 'Ended locally. No pending Core end remains in the local record.' : ended === 'pending' ? 'Ended locally. Ending pending in Core; its record has not been confirmed.' : ended === 'conflict' ? 'Ended locally. Core reports that this permission belongs to someone else; no Core end is claimed.' : 'Ended locally. Core confirmation: Not available yet.'} Calls approved on this permission are checked again just before sending and are stopped if it has ended. A call already sent cannot be undone here.</p>}
  </article>;
}
