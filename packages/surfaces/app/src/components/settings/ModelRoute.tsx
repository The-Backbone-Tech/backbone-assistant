// An explicit local choice precedes stored paid routes. A key is pasted here,
// sealed by the platform at once and never shown again; the field clears as soon as it is sent.
// Each route says who bills it (R-MODEL-01). A model already running on this computer is one click,
// with no key; nothing is started or downloaded from here.
import { LOCAL_RUNTIMES, ROUTE_CHOICES, type GatewayProvider, type LocalModels, type ModelSettings, type ModelSettingsChange, type OwnProvider } from '@backbone-next/platform';
import * as React from 'react';
import { call } from '../../lib/api';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';
import { SettingsRow } from './SettingsRow';
import { AcpAgentForm } from './AcpAgentForm';

export function ModelRouteSection() {
  const [s, setS] = React.useState<ModelSettings>();
  const [loadError, setLoadError] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    setLoadError(false);
    void call('settings.model.get', {}).then((settings) => {
      if (live) setS(settings);
    }).catch(() => { if (live) setLoadError(true); });
    return () => { live = false; };
  }, [reload]);
  if (loadError) return <div className="space-y-3 py-4"><p role="alert" className="text-sm text-danger">Couldn’t load the model settings.</p><Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>Try again</Button></div>;
  if (!s) return <p role="status" className="py-4 text-sm text-muted">Loading…</p>;
  return (
    <div>
      <SettingsRow title="Chat connection" about="The configured route for new turns. Available usage is checked when the model runs.">
        <div className="text-sm sm:text-right" data-testid="model-active">
          <p>
            <span className="text-muted">Engine</span> {s.harness}
          </p>
          <p>
            <span className="text-muted">Model</span> {s.active ? s.active.label : 'Not connected'}
          </p>
          {s.hint && <p className="mt-1 max-w-xs text-xs text-draft">{s.hint}</p>}
        </div>
      </SettingsRow>
      {/codex/i.test(s.harness) && <NativeModel onChange={setS} />}
      <RouteForm
        title="Your own key"
        note="Used when no local model is selected. API usage is billed separately from a Claude or ChatGPT subscription."
        route="own"
        choices={['anthropic', 'openai', 'openai-compatible']}
        current={s.own}
        onChange={setS}
      />
      <RouteForm title="Or a gateway" note="Used when no local model or own key is selected. Routes never switch silently." route="gateway" choices={['vercel', 'openrouter']} current={s.gateway} onChange={setS} />
      {!/codex/i.test(s.harness) && <LocalModelsBlock current={s.local ?? null} onChange={setS} />}
      <AcpAgentForm onChange={setS} machineClient={s.machineClient} />
    </div>
  );
}

/** The installed client's own models. It uses the sign-in already on this computer, so there is no key here. */
function NativeModel({ onChange }: { onChange: (s: ModelSettings) => void }) {
  const [models, setModels] = React.useState<{ id: string; label: string }[]>();
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    void call('models.list', {}).then(setModels);
  }, []);
  if (!models?.length) return null;
  const choose = async (model: string) => {
    const r = await call('settings.model.put', { change: { route: 'native', provider: 'codex', model } });
    setError(r.ok ? undefined : r.detail);
    if (r.ok) { onChange(r.value); setModels((list) => [...list!.filter((m) => m.id === model), ...list!.filter((m) => m.id !== model)]); }
  };
  return (
    <SettingsRow title={<label htmlFor="native-model">Codex model</label>} about="Uses the Codex sign-in on this computer and your plan.">
      <Select id="native-model" value={models[0]!.id} onChange={(e) => void choose(e.target.value)}>
        {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </Select>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </SettingsRow>
  );
}

/** What runs on this computer (Ollama, LM Studio, llama.cpp, vLLM), each model one click. Used when no key is set. */
function LocalModelsBlock({ current, onChange }: { current: ModelSettings['local'] | null; onChange: (s: ModelSettings) => void }) {
  const [found, setFound] = React.useState<LocalModels>();
  const [looking, setLooking] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const look = React.useCallback(async () => {
    setLooking(true);
    try { const r = await call('models.local', {}); setFound(Array.isArray(r?.runtimes) ? r : { runtimes: [] }); } catch { setFound({ runtimes: [] }); } finally { setLooking(false); }
  }, []);
  React.useEffect(() => { void look(); }, [look]);
  const send = async (change: ModelSettingsChange) => {
    setError(undefined);
    const r = await call('settings.model.put', { change });
    if (!r.ok) return setError(r.detail);
    onChange(r.value);
  };
  return (
    <section aria-label="Local models" className="mt-6" data-testid="local-models">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Local models</h3>
        {current && <Badge tone="committed">{LOCAL_RUNTIMES[current.provider].name} · {current.model}</Badge>}
      </div>
      <p className="mt-0.5 text-xs text-muted">A model running on this computer. No key and no charge. Your local selection takes priority over stored API keys until you clear it.</p>
      {!found ? (
        <p role="status" className="py-2 text-sm text-muted">Looking…</p>
      ) : found.runtimes.length === 0 ? (
        <p className="py-2 text-sm text-muted">Nothing running on this computer</p>
      ) : (
        found.runtimes.map((rt) => (
          <SettingsRow key={rt.provider} title={rt.name} about={rt.models.length ? rt.baseUrl : `${rt.baseUrl} · no models yet`}>
            <div className="flex flex-wrap gap-1.5 sm:justify-end">
              {rt.models.map((m) => {
                const chosen = current?.provider === rt.provider && current.baseUrl === rt.baseUrl && current.model === m;
                return (
                  <Button key={m} size="sm" variant={chosen ? 'default' : 'outline'} aria-pressed={chosen} onClick={() => void send({ route: 'local', provider: rt.provider, baseUrl: rt.baseUrl, model: m })}>
                    {m}
                  </Button>
                );
              })}
            </div>
          </SettingsRow>
        ))
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => void send({ route: 'local', clear: true })}>Clear local selection</Button>
        <Button type="button" variant="outline" disabled={looking} onClick={() => void look()}>{looking ? 'Looking…' : 'Look again'}</Button>
      </div>
    </section>
  );
}

type Provider = OwnProvider | GatewayProvider;

function RouteForm({ title, note, route, choices, current, onChange }: {
  title: string;
  note: string;
  route: 'own' | 'gateway';
  choices: Provider[];
  current: { provider: Provider; model: string; keySet: boolean; baseUrl?: string } | null;
  onChange: (s: ModelSettings) => void;
}) {
  const [provider, setProvider] = React.useState<Provider>(current?.provider ?? choices[0]);
  const [model, setModel] = React.useState(current?.model ?? '');
  const [baseUrl, setBaseUrl] = React.useState(current?.baseUrl ?? '');
  const [key, setKey] = React.useState('');
  const [error, setError] = React.useState<string>();
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const choice = ROUTE_CHOICES[provider];
  const isCurrent = current?.provider === provider;
  const id = React.useId();

  async function send(change: ModelSettingsChange) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    setKey('');
    try {
      const r = await call('settings.model.put', { change });
      if (!r.ok) return setError(r.detail);
      setSaved(!('clear' in change));
      onChange(r.value);
    } catch {
      setError('Couldn’t confirm the saved settings. Reopen this section to check the current connection before trying again.');
    } finally {
      setBusy(false);
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const base = { model: model.trim() || undefined, key: key.trim() || undefined };
    void send(route === 'own' ? { route, provider: provider as OwnProvider, ...base, baseUrl: provider === 'openai-compatible' ? baseUrl.trim() : undefined } : { route, provider: provider as GatewayProvider, ...base });
  }

  return (
    <form onSubmit={save} aria-label={title} aria-busy={busy} className="mt-6">
      <fieldset disabled={busy} className="min-w-0">
        <legend className="sr-only">{title}</legend>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          {current?.keySet && <Badge tone="committed">Key set · {ROUTE_CHOICES[current.provider].name}</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted">{note}</p>
        <SettingsRow title="Provider" about={`${choice.bills}.`}>
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <legend className="sr-only">{title}: provider</legend>
            {choices.map((c) => (
              <label key={c} className="inline-flex items-center gap-1.5">
                <input type="radio" className="accent-[var(--accent)]" name={`${route}-provider`} checked={provider === c} onChange={() => (setProvider(c), setModel(current?.provider === c ? current.model : ''), setSaved(false))} />
                {ROUTE_CHOICES[c].name.replace(' (your key)', '')}
              </label>
            ))}
        </fieldset>
      </SettingsRow>
      {provider === 'openai-compatible' && (
        <SettingsRow title={<label htmlFor={`${id}-url`}>Endpoint</label>} about="The address of a server that speaks the OpenAI API.">
          <Input id={`${id}-url`} className="sm:w-64" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" autoComplete="off" spellCheck={false} />
        </SettingsRow>
      )}
      <SettingsRow title={<label htmlFor={`${id}-model`}>Model</label>} about="Leave empty for the provider’s default.">
        <Input id={`${id}-model`} className="sm:w-64" value={model} onChange={(e) => setModel(e.target.value)} placeholder={choice.model || 'the model id the endpoint serves'} autoComplete="off" spellCheck={false} />
      </SettingsRow>
      <SettingsRow title={isCurrent && current?.keySet ? 'Replace the key' : 'Key'} about="Sealed on this computer at once and never shown again.">
        <Input className="sm:w-64" type="password" value={key} onChange={(e) => (setKey(e.target.value), setSaved(false))} autoComplete="off" spellCheck={false} aria-label={`${title}: key`} />
      </SettingsRow>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      {saved && !error && <p role="status" className="mt-2 text-xs text-muted">Connection saved. The key stays sealed on this computer. This does not test available usage.</p>}
      <div className="mt-3 flex justify-end gap-2">
        {current && (
          <Button type="button" variant="outline" onClick={() => void send({ route, clear: true })}>
            Remove
          </Button>
        )}
        <Button type="submit" disabled={busy || (!key.trim() && !(isCurrent && current?.keySet))}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      </fieldset>
    </form>
  );
}
