import * as React from 'react';
import { CONNECTOR_CATALOGUE, type CatalogueEntry, type CataloguePreset, type ConnectorServer } from '@backbone-next/platform';
import { catalogueAction } from '../../lib/api';
import { Button } from '../ui/button';
import { Select } from '../ui/input';
import { Badge } from '../ui/badge';
import { SettingsRow } from './SettingsRow';
import { catalogueDisconnected } from '../../lib/catalogue-consent';

export function ConnectorCatalogue({ servers, onChange }: { servers: ConnectorServer[]; onChange(): void }) {
  return <section aria-label="Connector catalogue" className="mt-3 rounded-lg border border-border px-3">
    <h3 className="pt-3 text-sm font-medium">Connect your accounts</h3>
    <p className="mt-1 text-xs text-muted">Choose an account, sign in in your browser, then review its tools. OAuth app setup is needed once. Disconnect stops local access, attempts provider token revocation and reports its outcome. To remove earlier results and what was made from them, withdraw their sources in Files.</p>
    {CONNECTOR_CATALOGUE.map(entry => <CatalogueRow key={entry.id} entry={entry} server={servers.find(server => server.catalogue === entry.id)} onChange={onChange} />)}
  </section>;
}
function CatalogueRow({ entry, server, onChange }: { entry: CatalogueEntry; server?: ConnectorServer; onChange(): void }) {
  const [preset, setPreset] = React.useState<CataloguePreset>('reads');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const operation = React.useRef(0);
  async function act(action: 'connect' | 'finish' | 'disconnect') {
    const current = ++operation.current;
    setBusy(true); setMessage(undefined);
    try {
      const result = await catalogueAction(action, entry.id, preset);
      if (current !== operation.current) return;
      setMessage(!result.ok ? result.detail : action === 'connect' && (result.value as { state?: string }).state === 'awaiting-google'
        ? 'Complete Google consent in your browser, then finish sign-in here.' : action === 'disconnect' ? catalogueDisconnected(result.value as import('@backbone-next/platform').CatalogueDisconnect) : undefined);
    } catch { if (current === operation.current) setMessage('This connection could not be confirmed. Check its status before starting again.'); }
    finally { if (current === operation.current) setBusy(false); onChange(); }
  }
  return <div data-testid={`catalogue-${entry.id}`}>
    <SettingsRow title={<span className="inline-flex items-center gap-2">{entry.name}<Badge tone={server?.enabled ? 'committed' : 'neutral'}>{server?.enabled ? 'Connected' : entry.configuration}</Badge></span>}
      about={<>{entry.server} {entry.version} · {entry.licence}{message && <span role="status" className="block">{message}</span>}</>}>
      {!server?.enabled && <Select size="sm" aria-label={`${entry.name} permissions`} disabled={busy} value={preset} onChange={event => setPreset(event.target.value as CataloguePreset)}>
        <option value="reads">Read tools</option>
        <option value="reads-and-effects">Reads and held effects</option>
      </Select>}
      {!server && <Button size="sm" disabled={busy} onClick={() => void act('connect')}>Connect {entry.name}</Button>}
      {server && !server.enabled && <Button size="sm" disabled={busy} onClick={() => void act('finish')}>Finish sign-in</Button>}
      {(server || busy) && <Button size="sm" variant="outline" onClick={() => void act('disconnect')}>{busy ? 'Cancel connection' : 'Disconnect'}</Button>}
    </SettingsRow>
  </div>;
}
