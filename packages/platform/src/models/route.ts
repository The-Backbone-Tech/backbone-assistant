// Model route policy (R-MODEL-02, DR A5): the policy lives in the host and the gateway is only
// transport. An explicit local choice comes before stored paid credentials; otherwise an own key or gateway, Vercel AI
// Gateway by default and OpenRouter as the alternative. There is no silent fallback: the chosen
// route either works or the turn says why. A subscription is not API entitlement (R-MODEL-03) and
// is used only through its vendor's own client (R-MODEL-01), so it is not a route for this engine.
// Credentials are sealed handles; the settings the app reads back never carry a value. A model
// running on this computer is a keyless local route the person picks in Settings (models/local.ts).
import { governedPolicy, routeDecision, engineDecision } from '../policy/index.ts';
import { saveAcpSettingsHeld } from '../composition/acp-settings.ts';
import { prepareAcpConfiguration, verifyAcpExecutableAccess } from '../composition/acp-executable.ts';
import { MachineClientStatusCache } from '../machine-client.ts';
import { routeFingerprint } from '../selection/route-identity.ts';
import { join } from 'node:path';
import { LOCAL_RUNTIMES, ROUTE_CHOICES, type GatewayProvider, type LocalProvider, type ModelSettings, type ModelSettingsChange, type OwnProvider } from '../api.ts';
import type { ModelRoute } from '../ports/harness.ts';
import { readJson, writeJson } from '../stub/fsx.ts';
import type { CredentialStore } from '../credentials/store.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../composition/home-lock.ts';

interface Stored {
  native?: { provider: 'codex'; model: string };
  own?: { provider: OwnProvider; model: string; credential: string; baseUrl?: string };
  gateway?: { provider: GatewayProvider; model: string; credential: string };
  local?: { provider: LocalProvider; baseUrl: string; model: string };
}

export const ROUTES = {
  anthropic: { ...ROUTE_CHOICES.anthropic, baseUrl: 'https://api.anthropic.com' },
  openai: { ...ROUTE_CHOICES.openai, baseUrl: 'https://api.openai.com/v1' },
  'openai-compatible': { ...ROUTE_CHOICES['openai-compatible'], baseUrl: '' },
  vercel: { ...ROUTE_CHOICES.vercel, baseUrl: 'https://ai-gateway.vercel.sh/v1' },
  openrouter: { ...ROUTE_CHOICES.openrouter, baseUrl: 'https://openrouter.ai/api/v1' },
} as const;

import { APP_NO_ROUTE as NO_ROUTE } from '../model-setup.ts';
export { NO_ROUTE };

const KEYCHAIN_OPENROUTER = 'keychain:backbone-openrouter';
export const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(\/|$)/;
const MODEL_ID = (m: string) => m.length > 0 && m.length <= 200 && !/[\s\p{Cc}\p{Cf}]/u.test(m);
const validLocal = (value: unknown): value is NonNullable<Stored['local']> => {
  if (!value || typeof value !== 'object') return false;
  const local = value as Record<string, unknown>;
  return typeof local.baseUrl === 'string' && LOOPBACK.test(local.baseUrl) && typeof local.model === 'string' && MODEL_ID(local.model)
    && typeof local.provider === 'string' && Object.hasOwn(LOCAL_RUNTIMES, local.provider);
};
class InvalidLocalModelSetting extends Error {
  constructor() { super('Local model setting is invalid. Choose a local model again or clear its setting; no paid route was selected.'); }
}
class InvalidModelEndpointSetting extends Error {
  constructor() { super('Model endpoint must be an http:// loopback address with a port on this computer. Correct or unset BACKBONE_MODEL_ENDPOINT; no paid route was selected.'); }
}

/**
 * Chosen local model, own key, gateway, opted-in Keychain, then ambient loopback endpoint.
 * Invalid local settings or nonempty endpoint overrides refuse before this search.
 */
export const ROUTE_ORDER = ['local', 'own', 'gateway', 'keychain', 'endpoint'] as const;

export class ModelRoutes {
  private readonly home: string;
  private readonly path: string;
  private readonly credentials: CredentialStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nativeClient: boolean;
  private readonly agentRoute?: ModelRoute;
  private readonly agentProblem?: string;
  private readonly machineState?: MachineClientStatusCache;
  /**
   * Whether a key the person stored in the Keychain under `backbone-openrouter` makes an OpenRouter
   * route, after their own key and a gateway key set in Settings. Only the desktop app passes true, so a
   * test or journey on this machine never finds that key and spends.
   */
  private readonly keychainGateway: boolean;
  constructor(home: string, credentials: CredentialStore, env: NodeJS.ProcessEnv = process.env, nativeClient = false, keychainGateway = false, agentRoute?: ModelRoute, agentProblem?: string) {
    this.agentRoute = agentRoute; this.agentProblem = agentProblem;
    if (agentRoute?.machineClient) this.machineState = new MachineClientStatusCache(agentRoute.machineClientEnvironment ?? env, agentRoute.machineExecutable);
    this.keychainGateway = keychainGateway;
    this.home = home;
    this.path = join(home, 'model-route.json');
    this.credentials = credentials;
    this.env = env;
    this.nativeClient = nativeClient;
  }

  private stored(): Stored {
    return readJson<Stored>(this.path, {});
  }

  /** The route for the next turn, in policy order; null when none is set. */
  resolve(): ModelRoute | null {
    return this.resolveFrom(this.stored());
  }

  /**
   * The route and the settings that describe it, from one read of the configuration: a choice made on
   * these settings is pinned to this route, with nothing read in between (selection/pin.ts).
   */
  snapshot(): { route: ModelRoute | null; settings: Omit<ModelSettings, 'harness'> } {
    const s = this.stored();
    const route = this.resolveFrom(s);
    return { route, settings: this.settingsFrom(s, route) };
  }

  private resolveFrom(s: Stored): ModelRoute | null {
    const policy = governedPolicy(this.home);
    const route = this.unrestrictedFrom(s);
    if (route) routeDecision(policy, route);
    return route;
  }

  private unrestrictedFrom(s: Stored): ModelRoute | null {
    if (this.agentProblem) return null;
    if (this.agentRoute) return this.agentRoute;
    if (this.nativeClient) {
      const model = this.env.BACKBONE_CODEX_MODEL ?? s.native?.model;
      return model ? { kind: 'native', provider: 'codex', baseUrl: '', model, label: `Codex · ${model} · Codex sign-in`, credential: null } : null;
    }
    if (Object.hasOwn(s, 'local') && !validLocal(s.local)) throw new InvalidLocalModelSetting();
    // Validate before any saved-key lookup: a malformed nonempty override is a
    // refusal, even when that key would otherwise outrank the ambient endpoint.
    const endpoint = this.env.BACKBONE_MODEL_ENDPOINT;
    if (endpoint && !LOOPBACK.test(endpoint)) throw new InvalidModelEndpointSetting();
    for (const step of ROUTE_ORDER) {
      const route = this.candidate(step, s);
      if (route) return route;
    }
    return null;
  }

  private candidate(step: (typeof ROUTE_ORDER)[number], s: Stored): ModelRoute | null {
    switch (step) {
      case 'own': {
        if (!s.own || !this.credentials.has(s.own.credential)) return null;
        const r = ROUTES[s.own.provider];
        return { kind: 'own', provider: s.own.provider, baseUrl: s.own.baseUrl ?? r.baseUrl, model: s.own.model, label: `${r.name} · ${s.own.model} · ${r.bills}`, credential: s.own.credential };
      }
      case 'gateway': {
        if (!s.gateway || !this.credentials.has(s.gateway.credential)) return null;
        const r = ROUTES[s.gateway.provider];
        return { kind: 'gateway', provider: s.gateway.provider, baseUrl: r.baseUrl, model: s.gateway.model, label: `${r.name} · ${s.gateway.model} · ${r.bills}`, credential: s.gateway.credential };
      }
      case 'endpoint': {
        // A keyless OpenAI-compatible server on this machine (a test's scripted model, or a local
        // model). Only the loopback is accepted, so this setting can never send work elsewhere.
        const endpoint = this.env.BACKBONE_MODEL_ENDPOINT;
        if (!endpoint) return null;
        const model = this.env.BACKBONE_MODEL_ID ?? 'local-model';
        return { kind: 'endpoint', provider: 'openai-compatible', baseUrl: endpoint, model, label: `Local endpoint · ${model} · no charge`, credential: null };
      }
      case 'local': {
        // Checked again here: a hand-edited file naming another host is not a route.
        const l = s.local;
        if (!validLocal(l)) return null;
        return { kind: 'endpoint', provider: 'openai-compatible', baseUrl: l.baseUrl, model: l.model, label: `${LOCAL_RUNTIMES[l.provider].name} · ${l.model} · on this computer, keyless`, credential: null };
      }
      case 'keychain': {
        if (!this.keychainGateway || !this.credentials.has(KEYCHAIN_OPENROUTER)) return null;
        const r = ROUTES.openrouter;
        const model = s.gateway?.provider === 'openrouter' ? s.gateway.model : r.model;
        return { kind: 'gateway', provider: 'openrouter', baseUrl: r.baseUrl, model, label: `${r.name} · ${model} · ${r.bills} · key in your Keychain`, credential: KEYCHAIN_OPENROUTER };
      }
    }
  }

  settings(): Omit<ModelSettings, 'harness'> {
    const s = this.stored();
    try { return this.settingsFrom(s, this.resolveFrom(s)); }
    catch (error) {
      if (!(error instanceof InvalidLocalModelSetting) && !(error instanceof InvalidModelEndpointSetting)) throw error;
      return { ...this.settingsFrom(s, null), hint: error.message };
    }
  }

  private settingsFrom(s: Stored, active: ModelRoute | null): Omit<ModelSettings, 'harness'> {
    return {
      own: s.own ? { provider: s.own.provider, model: s.own.model, keySet: this.credentials.has(s.own.credential), ...(s.own.baseUrl ? { baseUrl: s.own.baseUrl } : {}) } : null,
      gateway: s.gateway ? { provider: s.gateway.provider, model: s.gateway.model, keySet: this.credentials.has(s.gateway.credential) } : null,
      local: validLocal(s.local) ? { provider: s.local.provider, baseUrl: s.local.baseUrl, model: s.local.model } : null,
      active: active && { kind: active.kind, label: active.label, model: active.model, fingerprint: routeFingerprint(active), ...(active.kind === 'endpoint' && !active.credential && LOOPBACK.test(active.baseUrl) ? { keylessLoopback: true } : {}) },
      hint: active ? active.kind === 'agent' ? active.label : null : this.agentProblem ?? (this.nativeClient ? 'Choose a model for the installed Codex client. Its own sign-in is used; no API key is imported.' : NO_ROUTE),
      ...(this.agentRoute?.machineClient ? { machineClient: this.agentRoute.machineClient, machineClientState: this.machineState!.read() } : {}),
      ...(this.nativeClient ? { native: { provider: 'codex' as const, model: active?.model ?? '' } } : {}),
    };
  }

  /**
   * Set or clear a route. A new key is sealed and the old one revoked; the value is not kept anywhere
   * else. The whole read, seal, write and revoke holds the data home's lock (this process's queue,
   * then a private OS-held file descriptor across processes), so two saves at once never lose one another's route.
   * The old key is revoked only once the route no longer names it.
   */
  change(c: ModelSettingsChange): Promise<Omit<ModelSettings, 'harness'>> {
    if (c.route === 'agent-refresh') return this.machineState ? this.machineState.refresh().then(() => this.settings()) : Promise.resolve(this.settings());
    if (c.route === 'agent-resolve') {
      const prepared = prepareAcpConfiguration(this.home, c.configuration, this.env);
      return verifyAcpExecutableAccess(prepared.acceptance).then(() => ({ ...this.settings(), acpPrepared: prepared }));
    }
    if (c.route === 'agent') return verifyAcpExecutableAccess(c.configuration.acceptance).then(() => withHomeLock(this.home, () => this.changeHeld(c)));
    return withHomeLock(this.home, () => this.changeHeld(c));
  }

  private async changeHeld(c: ModelSettingsChange): Promise<Omit<ModelSettings, 'harness'>> {
    if (c.route === 'agent-resolve' || c.route === 'agent-refresh') throw new Error('Resolve an ACP executable before taking the home lock.');
    const policy = governedPolicy(this.home);
    if (c.route === 'agent') {
      engineDecision(policy, 'harness-acp', c.configuration);
      routeDecision(policy, { kind: 'agent', provider: `acp:${c.configuration.agent}` });
      saveAcpSettingsHeld(this.home, c.configuration);
      return { ...this.settings(), hint: 'ACP configuration saved. Restart the app or daemon to use it. BACKBONE_HARNESS overrides this choice.' };
    }
    if (!('clear' in c)) routeDecision(policy, { kind: c.route === 'local' ? 'endpoint' : c.route, provider: c.route === 'local' ? 'openai-compatible' : c.route === 'native' ? 'codex' : c.provider });
    if (this.agentProblem) throw new Error(this.agentProblem);
    if (this.agentRoute) throw new Error(`This ACP agent chooses its model and sign-in outside the host. ${this.agentRoute.label}`);
    const s = this.stored();
    if (c.route === 'native') {
      if (!this.nativeClient) throw new Error('This engine uses an API route. Select the native Codex engine before configuring its model.');
      const model = c.model.trim();
      if (!model || model.length > 200 || /\s/.test(model)) throw new Error('Choose a valid model identifier.');
      s.native = { provider: 'codex', model };
      assertHomeWriteAdmission(this.home);
      writeJson(this.path, s);
      return this.settings();
    }
    if (c.route === 'local') {
      // No credential: a local route is a loopback address and a model id, checked before anything is written.
      if ('clear' in c) delete s.local;
      else {
        if (!Object.hasOwn(LOCAL_RUNTIMES, c.provider)) throw new Error('Choose a local runtime: Ollama, LM Studio, llama.cpp, vLLM or another local server.');
        const baseUrl = String(c.baseUrl ?? '').trim().replace(/\/+$/, '');
        if (!LOOPBACK.test(baseUrl)) throw new Error('A local model must be on this computer: an http:// address on 127.0.0.1, localhost or [::1], with its port.');
        const model = String(c.model ?? '').trim();
        if (!MODEL_ID(model)) throw new Error('Choose the model this server runs.');
        s.local = { provider: c.provider, baseUrl, model };
      }
      assertHomeWriteAdmission(this.home);
      writeJson(this.path, s);
      return this.settings();
    }
    const prior = s[c.route];
    let retired: string | undefined;
    if ('clear' in c) {
      retired = prior?.credential;
      delete s[c.route];
    } else {
      // Everything is checked before a key is sealed, so a refused change leaves nothing behind.
      const key = c.key?.trim();
      const same = prior?.provider === c.provider ? prior : undefined;
      if (!key && !(same && this.credentials.has(same.credential))) throw new Error('Paste a key to use this route.');
      const model = c.model?.trim() || same?.model || ROUTES[c.provider].model;
      if (!model) throw new Error('Name the model this endpoint serves.');
      let baseUrl: string | undefined;
      if (c.provider === 'openai-compatible') {
        baseUrl = (('baseUrl' in c && c.baseUrl?.trim()) || s.own?.baseUrl || '').replace(/\/+$/, '');
        if (!/^https:\/\/[^\s]+$/.test(baseUrl) && !LOOPBACK.test(baseUrl)) throw new Error('The endpoint must be an https:// address, or http:// on this computer.');
      }
      const credential = key ? await this.credentials.put(key, ROUTES[c.provider].name) : same!.credential;
      if (key && prior) retired = prior.credential;
      if (c.route === 'own') s.own = { provider: c.provider, model, credential, ...(baseUrl ? { baseUrl } : {}) };
      else s.gateway = { provider: c.provider, model, credential };
      // Saving a key is an explicit route choice; an older local preference must not mask it.
      delete s.local;
    }
    assertHomeWriteAdmission(this.home);
    writeJson(this.path, s);
    if (retired) this.credentials.revoke(retired);
    return this.settings();
  }

}
