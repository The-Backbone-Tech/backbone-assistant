// First run: one small card says what Full access reaches, once per data folder (like the Mac file-access banner).
// Either button, changing the permission, or sending a first message records the decision in the viewer prefs.
import * as React from 'react';
import { brand } from '../brand';
import { call } from '../lib/api';
import { useApp, useLive } from '../lib/state';
import { CHOOSE_PERMISSION } from './Composer';
import { Button } from './ui/button';

export function FullAccessCard({ projectId }: { projectId?: string }) {
  const { prefs, setPrefs, threads, models, projects, tick } = useApp();
  // Show only the current selection's live answer; changing projects or sharing
  // hides the previous offer while the new audience is being read.
  const context = useLive(async () => {
    try {
      const [identity, engine] = await Promise.all([call('identity.get', {}), call('settings.model.get', {})]);
      if (!identity.ok || !identity.value.deviceOwner || identity.value.person.role !== 'owner') return undefined;
      const shared = projectId ? await call('identity.sharing', { projectId }).then(sharing =>
        sharing.ok && typeof sharing.value.nativeAccountTools === 'boolean' ? !sharing.value.nativeAccountTools : undefined)
        : identity.value.people.some(person => person.id !== identity.value.person.id && person.status === 'active' && ['owner', 'admin'].includes(person.role));
      return { projectId, tick, shared, engine: engine?.native?.provider === 'codex' ? 'codex' : 'other' };
    } catch { return undefined; }
  }, [projectId], undefined as { projectId?: string; tick: number; shared?: boolean; engine: string } | undefined);
  const permissions = models[0]?.permissions;
  const full = (prefs.composer?.permission ?? 'full') === 'full' && (!permissions || permissions.includes('full'));
  if (prefs.fullAccessNotice || threads.length > 0 || !full || !context || context.projectId !== projectId || context.tick !== tick) return null;
  const decide = () => setPrefs((p) => ({ ...p, fullAccessNotice: 'decided' }));
  return <FullAccessNotice engine={context.engine} deviceOwner={true} shared={context.shared} viewerOnly={projects.find(project => project.id === projectId)?.access === 'viewer'} decide={decide} />;
}

export function FullAccessNotice({ engine, deviceOwner, shared, viewerOnly, decide }: { engine: string; deviceOwner: boolean; shared?: boolean; viewerOnly: boolean; decide(): void }) {
  if (!deviceOwner || viewerOnly || shared === undefined) return null;
  return <div role="region" aria-label="Full access" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm">
    <p className="w-full font-medium">{brand.name} starts with Full access</p>
    <p className="w-full text-muted">
      It works freely with this project&apos;s files and tools on this Mac.
      {engine === 'codex' && !shared && ' With the Codex engine it can also use the connectors of your own Codex app (mail, calendar, files), including sending, changing and deleting, without asking each time, also in scheduled and delegated work.'}
      {' '}Every step is shown in the work record.
    </p>
    <Button size="sm" onClick={decide}>Keep Full access</Button>
    <Button size="sm" variant="outline" onClick={() => { decide(); window.dispatchEvent(new Event(CHOOSE_PERMISSION)); }}>Choose another</Button>
  </div>;
}
