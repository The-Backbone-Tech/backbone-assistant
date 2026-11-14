import { call } from '../../lib/api';
import * as React from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export function TelemetrySection() {
  const [fixed, setFixed] = React.useState(false);
  const [endpoint, setEndpoint] = React.useState('');
  const [headers, setHeaders] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const available = !!window.backbone?.configureTelemetry;
  React.useEffect(() => {
    let live = true;
    void call('settings.policy.get', {}).then(policy => { if (live) setFixed(policy.state === 'refused' || (policy.state === 'verified' && policy.fixed.includes('telemetryEndpoint'))); }, () => { if (live) setFixed(true); });
    void window.backbone?.telemetrySettings?.().then(value => { if (live) setEndpoint(value.endpoint); }, () => { if (live) setMessage('Telemetry settings could not be read.'); });
    return () => { live = false; };
  }, []);
  if (!available) return <p className="py-4 text-sm text-muted">Configure telemetry in the desktop app or with the telemetry command on its data folder.</p>;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      await window.backbone!.configureTelemetry!({ endpoint, ...(headers.trim() ? { headers } : {}) });
      setHeaders('');
      setMessage(endpoint ? 'Saved. Restart the app to apply these settings.' : 'Telemetry disabled and stored collector headers removed. Restart the app to apply.');
    } catch { setMessage('Could not save. Use HTTPS, or HTTP on localhost, 127.0.0.0/8 or ::1, with an explicit traces path, no URL credentials, query or fragment, and valid JSON headers.'); }
    finally { setBusy(false); }
  };
  return <form className="space-y-4 py-4 text-sm" onSubmit={event => void save(event)}>
    <p>Send timing, counts and opaque correlation IDs to your collector. Prompts, answers, document names, tool arguments and results are never exported.</p>
    <label className="block space-y-1">
      <span>OTLP traces endpoint</span>
      <Input aria-label="OTLP traces endpoint" type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://collector.example/v1/traces" disabled={busy || fixed} />
      <span className="block text-xs text-muted">{fixed ? 'Fixed by policy; cannot be changed here.' : 'Leave empty to disable telemetry and remove its stored headers.'}</span>
    </label>
    <label className="block space-y-1">
      <span>Collector headers (JSON)</span>
      <Input aria-label="Collector headers (JSON)" type="password" value={headers} onChange={event => setHeaders(event.target.value)} autoComplete="new-password" spellCheck={false} maxLength={32768} disabled={busy} />
      <span className="block text-xs text-muted">Enter JSON on one line. Stored sealed with this data folder's credentials. While enabled, leave blank to keep existing headers, or enter {'{}'} to clear them. Stored values are never shown.</span>
    </label>
    <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save telemetry settings'}</Button>
    {message && <p role="status" className="text-xs text-muted">{message}</p>}
  </form>;
}
