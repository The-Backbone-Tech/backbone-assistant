// The engine, chosen in the app through the same call `backbone engine` uses (`settings.engine.put`).
// The choice applies when the app next starts; the app has no relaunch for settings, so the person is told
// to quit and reopen it. An engine that cannot run here is listed with the reason, and one the managed
// policy refuses is listed but not offered. A lost answer is shown as not confirmed and never sent again.
import type { EngineChoices } from '@backbone-next/platform';
import * as React from 'react';
import { call } from '../../lib/api';
import { Button } from '../ui/button';
import { SettingsRow } from './SettingsRow';

export const ENGINE_ABOUT = 'The engine runs each chat and decides which tools it has. Pi uses the model you choose below; Codex and other agents bring their own tools and sign-in, and colleagues are then answered by the shared-work model.';

const NOT_CONFIRMED_READ = 'The change was not confirmed. The saved engine is shown above; check it before choosing again.';
const NOT_CONFIRMED_UNREAD = 'The change was not confirmed, and checking the saved engine failed. Check again to see what is saved before choosing again.';

const nameOf = (choices: EngineChoices, id: string | null) => choices.options.find((o) => o.id === id)?.label ?? (id === 'scripted' ? 'Scripted practice' : id ?? 'Not known');

export function EngineChoice() {
  const [choices, setChoices] = React.useState<EngineChoices>();
  const [loadError, setLoadError] = React.useState(false);
  const [selected, setSelected] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ kind: 'saved' | 'refused' | 'unknown'; text: string }>();
  // After a save whose outcome is not known, Save stays off until a read establishes what is saved.
  const [reconciling, setReconciling] = React.useState(false);
  // The practice engine is for development: an unpacked build offers it; an installed app only when in use or saved.
  const [development, setDevelopment] = React.useState(false);
  const id = React.useId();
  React.useEffect(() => {
    let live = true;
    void window.backbone?.appInfo?.().then((info) => { if (live) setDevelopment(info?.packaged === false); }, () => {});
    return () => { live = false; };
  }, []);
  const load = React.useCallback(async (fresh = false): Promise<boolean> => {
    try {
      const value = await call('settings.engines.get', fresh ? { fresh: true } : {});
      if (!value || !Array.isArray(value.options)) throw new Error('No engine list');
      const saved = value.options.find((o) => o.id === (value.stored ?? value.next ?? value.running))?.name;
      setLoadError(false);
      setChoices(value);
      setSelected((prior) => prior ?? saved);
      return true;
    } catch { setLoadError(true); return false; }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  async function reconcile(fresh: boolean) {
    const read = await load(fresh);
    if (read) {
      setReconciling(false);
      setResult((prior) => prior?.kind === 'unknown' ? { kind: 'unknown', text: NOT_CONFIRMED_READ } : prior);
    } else setResult((prior) => prior?.kind === 'unknown' ? { kind: 'unknown', text: NOT_CONFIRMED_UNREAD } : prior);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || reconciling || !selected || !choices) return;
    const chosen = choices.options.find((o) => o.name === selected)!;
    setBusy(true); setResult(undefined);
    let unknown = false;
    try {
      const r = await call('settings.engine.put', { engine: selected });
      if (r.ok) setResult({ kind: 'saved', text: choices.environment
        ? `Saved. This computer starts the app with a fixed engine, so ${nameOf(choices, choices.next)} runs until that setting is removed.`
        : `Saved. ${chosen.label} will run when the app next starts. Quit and reopen the app to apply it.` });
      else if (r.outcome === 'REFUSED') setResult({ kind: 'refused', text: `The engine was not changed. ${r.detail}` });
      else unknown = true;
    } catch { unknown = true; }
    if (unknown) { setReconciling(true); setResult({ kind: 'unknown', text: 'The change was not confirmed. Checking what is saved…' }); }
    setBusy(false);
    if (unknown) await reconcile(false); else await load();
  }

  const next = choices && choices.next !== choices.running ? choices.next : undefined;
  const savedOption = choices?.options.find((o) => o.id === (choices.stored ?? choices.next));
  const shown = choices?.options.filter((o) => o.name !== 'stub' || development || [choices.running, choices.stored, choices.next].includes(o.id)) ?? [];
  return (
    <section aria-label="Engine">
      <SettingsRow title="Engine" about={ENGINE_ABOUT}>
        <div className="text-sm sm:text-right" data-testid="engine-current">
          {loadError && !choices ? <p role="alert" className="text-danger">Couldn’t check the engines on this computer.</p>
            : !choices ? <p role="status" className="text-muted">Checking…</p>
            : <>
              <p><span className="text-muted">In use now:</span> {nameOf(choices, choices.running)}</p>
              {choices.environment && choices.stored && choices.stored !== choices.next && <p><span className="text-muted">Saved choice:</span> {nameOf(choices, choices.stored)}</p>}
              {(next !== undefined || (choices.environment && choices.stored && choices.stored !== choices.next)) && <p><span className="text-muted">Next start:</span> {nameOf(choices, choices.next)}{choices.environment && ', fixed at launch'}</p>}
            </>}
          {loadError && !choices && <Button variant="outline" size="sm" className="mt-1" onClick={() => void load(true)}>Try again</Button>}
        </div>
      </SettingsRow>
      {result?.kind === 'saved' && <p role="status" className="mt-2 text-xs text-muted">{result.text}</p>}
      {choices && <details className="mt-3">
        <summary className="cursor-pointer text-sm">Change engine</summary>
        <form aria-label="Choose an engine" aria-busy={busy} onSubmit={save}>
          <fieldset disabled={busy} className="min-w-0">
            <legend className="sr-only">Engine</legend>
            <div role="radiogroup" aria-label="Engine">
              {shown.map((o) => {
                const off = o.state !== 'available';
                return (
                  <SettingsRow key={o.name} title={<span data-testid={`engine-${o.name}`} className="inline-flex items-start gap-2">
                    <input type="radio" id={`${id}-${o.name}`} name={`${id}-engine`} className="mt-1 accent-[var(--accent)]" value={o.name} checked={selected === o.name} disabled={off} aria-describedby={`${id}-${o.name}-about`} onChange={() => (setSelected(o.name), setResult(undefined))} />
                    <span>
                      <label htmlFor={`${id}-${o.name}`} className={off ? 'text-muted' : undefined}>{o.label}</label>
                      <span id={`${id}-${o.name}-about`} className="block text-xs font-normal leading-5 text-muted">{o.about}{o.reason && <span className="block text-draft">{o.reason}</span>}</span>
                    </span>
                  </span>} />
                );
              })}
            </div>
            {choices.environment && <p className="mt-2 text-xs text-draft">BACKBONE_HARNESS is set for this app, so it runs the engine named there whatever is saved here.</p>}
            {(result?.kind === 'refused' || result?.kind === 'unknown') && <p role="alert" className="mt-2 text-xs text-danger">{result.text}</p>}
            {loadError && !reconciling && result?.kind !== 'unknown' && <p role="alert" className="mt-2 text-xs text-danger">Couldn’t check the engines again. Try Check again.</p>}
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => void (reconciling ? reconcile(true) : load(true))}>Check again</Button>
              <Button type="submit" disabled={busy || reconciling || !selected || selected === savedOption?.name}>{busy ? 'Saving…' : 'Save engine'}</Button>
            </div>
          </fieldset>
        </form>
      </details>}
    </section>
  );
}
