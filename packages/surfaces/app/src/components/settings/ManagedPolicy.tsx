import * as React from 'react';
import type { Result } from '@backbone-next/platform';
import { call } from '../../lib/api';
export function ManagedPolicy() {
  const [policy, setPolicy] = React.useState<Result<'settings.policy.get'>>();
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    void call('settings.policy.get', {}).then(value => { if (live) setPolicy(value); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  if (failed) return <p role="alert">Managed policy could not be checked. Governed work remains refused.</p>;
  if (!policy || policy.state === 'none') return null;
  if (policy.state === 'refused') return <p role="alert">{policy.detail}</p>;
  return <div role="status" className="space-y-1 border-b border-border py-3 text-sm" data-testid="managed-policy">
    <p>Managed policy {policy.id}, version {policy.version}</p>
    {policy.fixed.map(key => <p key={key}>{key}: {policy.descriptions[key]}; fixed by policy; cannot be changed here.</p>)}
    {policy.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
  </div>;
}
