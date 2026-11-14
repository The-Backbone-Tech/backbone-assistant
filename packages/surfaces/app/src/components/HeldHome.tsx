// A data home another process owns: one owner per home, so the app says who holds it and how to free
// it, and opens nothing else. Usually that is the background service (the daemon).
import type { HostStatus } from '@backbone-next/platform';
import { Lock } from 'lucide-react';
import { brand } from '../brand';

export function HeldHome({ status }: { status: HostStatus }) {
  const daemon = status.heldBy?.kind === 'daemon' ? status.heldBy : undefined;
  return (
    <div className="flex h-full items-center justify-center bg-bg px-4 text-fg" data-ready="true">
      <section className="max-w-lg space-y-3 text-sm" data-testid="home-held" aria-label="This data folder is in use">
        <Lock className="size-6 text-muted" aria-hidden />
        <h1 className="text-lg font-semibold">This data folder is in use</h1>
        {daemon
          ? <p>{brand.name}&rsquo;s background service holds it (pid {daemon.pid}{daemon.since ? `, since ${new Date(daemon.since).toLocaleString()}` : ''}). It keeps schedules and goals going while the app is closed, and one process holds a data folder at a time.</p>
          : <p>Another process holds it. One process holds a data folder at a time.</p>}
        <p>To free it, stop that process:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>if it runs as your login agent: <code className="font-mono text-xs">backbone daemon uninstall</code></li>
          <li>if you started it in a terminal: press Ctrl-C there</li>
        </ul>
        {daemon
          ? <p>The background service keeps this data folder’s keys in plain files, and the installed app opens only data folders whose keys are in the Keychain. So once it stops, use this data folder from the command line or run the service again; the app works on a data folder of its own.</p>
          : <p>Then open the app again.</p>}
        <p className="text-xs text-muted">{status.detail}</p>
      </section>
    </div>
  );
}
