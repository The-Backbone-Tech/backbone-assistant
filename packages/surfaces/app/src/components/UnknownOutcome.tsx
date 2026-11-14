import * as React from 'react';
import type { Turn } from '@backbone-next/platform';
import { checkedTurn } from '../lib/api';
import { Button } from './ui/button';

export function UnknownOutcome({ turn, threadId }: { turn: Turn; threadId: string }) {
  const [busy, setBusy] = React.useState(false), [problem, setProblem] = React.useState('');
  if (!turn.unknownOutcome && !turn.unknownCheck && !turn.unknownChecked) return null;
  const earlier = turn.unknownCheckedCurrent === false;
  const check = turn.unknownCheck && !earlier ? undefined : turn.unknownChecked;
  return <div role="status" className="rounded-lg border border-draft px-3 py-2 text-sm" data-testid="unknown-outcome">
    <p>{check ? earlier
      ? `Earlier check by ${check.byName ?? check.by} on ${new Date(check.at).toLocaleString()}; the turn changed and this check no longer applies.`
      : `unknown, checked by ${check.byName ?? check.by} on ${new Date(check.at).toLocaleString()}` : 'Unknown outcome'}</p>
    {check && <details><summary>Inspection details</summary><p>Checker ID: {check.by}</p></details>}
    {(turn.unknownCheck?.steps ?? check?.steps)?.map((s, i) => <p key={i}>{s.label} · {new Date(s.at).toLocaleString()}</p>)}
    {turn.unknownCheck && <Button size="sm" disabled={busy} onClick={() => {
      setBusy(true); setProblem('');
      void checkedTurn(threadId, turn.id).then(r => { if (!r.ok) setProblem(r.detail); }, () => setProblem('The check could not be confirmed. Reload the conversation to inspect its record.')).finally(() => setBusy(false));
    }}>I checked this myself</Button>}
    {problem && <p role="alert">{problem}</p>}
  </div>;
}
