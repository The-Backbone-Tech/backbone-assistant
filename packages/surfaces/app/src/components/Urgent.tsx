// An emergency a heartbeat found: told at once, outside the daily brief, and counted by the host.
// Only security and money emergencies come this way; everything else waits for the brief.
import { ShieldAlert } from 'lucide-react';
import * as React from 'react';
import { onEvent } from '../lib/api';
import { useApp } from '../lib/state';
import { Button } from './ui/button';

export function Urgent() {
  const { setPrefs } = useApp();
  const [said, setSaid] = React.useState<string[]>([]);
  React.useEffect(() => onEvent((e) => { if (e.topic === 'schedules' && e.urgent) setSaid((s) => [...s, e.urgent!]); }), []);
  if (!said.length) return null;
  return (
    <div role="alert" className="flex items-start gap-2 border-b border-danger bg-danger/10 px-4 py-2 text-sm">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <span className="min-w-0 flex-1"><strong className="font-medium">Emergency</strong> {said.at(-1)}{said.length > 1 ? ` (and ${said.length - 1} more)` : ''}</span>
      <Button variant="outline" size="sm" onClick={() => setPrefs((p) => ({ ...p, view: 'scheduled', selectedThreadId: undefined }))}>Open</Button>
      <Button variant="ghost" size="sm" onClick={() => setSaid([])}>Dismiss</Button>
    </div>
  );
}
