// What routes exist here, and whether each is eligible now, for solution selection (choose.ts):
// the person's signed-in native tool, the configured model route, models running on this computer,
// and code run here with no model. Gathered from what the host already knows; nothing is signed in,
// bought or started to find out. A route that is not eligible says why, in words the person can act on.
import type { LocalModels, ModelSettings } from '../api.ts';
import type { Route } from './choose.ts';
import { claudeCheck } from '../composition/doctor.ts';
import { routeFingerprint } from './route-identity.ts';

export interface InventoryInputs {
  /** `codex login status`, as the doctor reads it (composition/doctor.ts). */
  /** Maintained tools for a known job that run here with no model (a converter, a checker); none is assumed. */
  tools?: { id: string; label: string }[];
  /** Version-only client discovery never imports a subscription credential. */
  claude?: { status: 'ok' | 'warn' | 'fail'; detail: string };
  codex: { status: 'ok' | 'warn' | 'fail'; detail: string; billing?: 'plan' | 'metered' | 'unknown' };
  settings: ModelSettings;
  local: LocalModels;
}

export function inventory({ codex, settings, local, tools = [], claude = claudeCheck() }: InventoryInputs): Route[] {
  const routes: Route[] = [];
  routes.push({
    id: 'codex', label: 'Codex (the person\'s signed-in client)', kind: 'native-engine', model: settings.active?.kind === 'native' ? settings.active.model : undefined, fingerprint: settings.active?.kind === 'native' ? settings.active.fingerprint : undefined, capabilities: ['model', 'code', 'files'], network: true, spends: codex.billing === 'plan' ? 'plan' : 'metered',
    availability: { state: codex.status === 'ok' ? 'now' : 'setup', detail: codex.status === 'ok' ? codex.billing === 'plan' ? 'Client status reports subscription sign-in. Usage still counts; quota is not checked.' : codex.billing === 'metered' || codex.billing === 'unknown' ? 'Client sign-in is present, but an existing subscription is not established; metered permission is required.' : 'Client sign-in is present. Provider quota and limits are not independently checked.' : 'Install the Codex client if absent and sign in through its own client. No account credential is imported.' },
    eligible: codex.status === 'ok',
    ...(codex.status === 'ok' ? {} : { blocked: /(?:^|: )absent$/.test(codex.detail) ? 'Codex is not installed here' : /(?:^|: )signed out$/.test(codex.detail) ? 'Codex is installed but signed out; the person signs in' : 'Codex could not be checked' }),
  });
  routes.push({
    id: 'claude-client', label: 'Claude client', kind: 'client-setup', capabilities: ['model', 'code', 'files'], network: true, spends: 'plan', eligible: false,
    blocked: claude.status === 'ok' ? 'Claude is installed; sign-in and entitlement are not checked. Configure a supported ACP agent bridge and select ACP before this client can run here.' : 'Claude client was not found or could not be checked. Install a supported client and ACP bridge, verify sign-in, then select ACP.',
    availability: { state: 'setup', detail: claude.status === 'ok' ? 'Installed client observed by its version command. Configure its ACP bridge and verify client access; no subscription credential is imported.' : 'Install and configure a supported ACP client bridge. Sign-in and entitlement remain unverified.' },
  });
  const active = settings.active && settings.active.kind !== 'native' && settings.active.kind !== 'agent' ? settings.active : null;
  // Use the effective route snapshot: an inactive stored local setting proves nothing about it.
  const localActive = active?.kind === 'endpoint' && active.keylessLoopback === true;
  // Preserve the person's saved local identity only when it describes this exact effective
  // destination. Stored settings or a scanned server alone must never supply execution authority.
  const saved = settings.local;
  const savedId = localActive && saved && active.model === saved.model && active.fingerprint === routeFingerprint({ kind: 'endpoint', provider: 'openai-compatible', baseUrl: saved.baseUrl, model: saved.model, label: '', credential: null })
    ? `local:${saved.provider}:${saved.model}` : undefined;
  routes.push({
    id: savedId ?? 'model-route', label: active ? `Pi on ${active.label}` : 'Pi on a model route', kind: 'model-route', model: active?.model, fingerprint: active?.fingerprint, capabilities: ['model', 'files'], network: !localActive, spends: localActive ? 'none' : 'metered',
    eligible: !!active,
    availability: active ? { state: 'now', detail: localActive ? 'The effective route is a configured keyless model endpoint on this computer.' : 'Configured route; provider quota and entitlement are not independently checked.' } : settings.own?.keySet || settings.gateway?.keySet ? { state: 'setup', detail: 'A key is configured. Select its model route in Settings, then check it.' } : { state: 'entitlement', detail: 'No API credential was found in this home. Supply an existing entitled API key or obtain API access; a client subscription alone does not establish API access.' },
    ...(active ? {} : { blocked: settings.hint ?? 'no model route is set: an API key or gateway key the person adds' }),
  });
  if (settings.active?.kind === 'agent') {
    // Reuse the selected bridge's bounded status cache; discovery never launches an auth probe.
    const machine = settings.machineClient === 'claude', state = settings.machineClientState?.state ?? 'checking';
    const ready = !machine || state === 'signed-in';
    const detail = {
      checking: 'The configured Claude client sign-in check is pending. Refresh its client status in Settings after the check finishes.',
      'signed-in': 'The selected ACP bridge reports Claude client sign-in. Quota and billing are not independently checked; metered permission is still required.',
      'signed-out': 'Sign in through the installed Claude client, then refresh its client status in Settings.',
      'different-auth': 'Configure this bridge for Claude account sign-in, then refresh its client status in Settings. The observed authentication does not establish that machine-client route.',
      absent: 'Install the Claude client, check its configured executable in Settings, then refresh its client status.',
      error: 'Check the configured Claude executable and refresh its client status in Settings; sign-in could not be established.',
    }[state];
    routes.push({ id: 'acp', label: settings.active.label, kind: 'agent-engine', model: settings.active.model, fingerprint: settings.active.fingerprint, capabilities: ['model', 'code', 'files'], network: true, spends: 'metered', eligible: ready,
      ...(machine ? { availability: { state: ready ? 'now' : 'setup', detail }, ...(!ready ? { blocked: detail } : {}) } : {}),
    });
  }
  for (const runtime of local.runtimes) for (const model of runtime.models) {
    const id = `local:${runtime.provider}:${model}`;
    if (id === savedId && runtime.baseUrl === saved?.baseUrl) continue; // Already described as the configured route.
    routes.push({ id: id === savedId ? `discovered:${id}` : id, label: `${model} on ${runtime.name}, this computer`, model, kind: 'local-model', capabilities: ['model', 'files'], network: true, spends: 'metered', eligible: false,
      blocked: 'Select this chat model in Settings before using it. Discovery alone establishes neither chat capability nor billing; a loopback server may proxy a paid provider.',
      availability: { state: 'setup', detail: 'Select and check this chat model in Settings. A discovered endpoint is not an approved task destination.' },
    });
  }
  // Code does not write itself: with no model, only a maintained tool for the job can run here.
  for (const t of tools) routes.push({ id: `tool:${t.id}`, label: `${t.label}, run on this computer`, kind: 'code-only', capabilities: ['code', 'files'], network: false, spends: 'none', eligible: true });
  // A Host runs one engine. Machine availability and this home's remaining setup stay distinct.
  for (const route of routes.filter((r) => r.eligible)) {
    const engine = route.kind === 'native-engine' ? 'codex' : route.kind === 'agent-engine' ? 'acp' : route.kind === 'local-model' || route.kind === 'model-route' ? 'pi' : null;
    if (engine && !new RegExp(`^(?:harness-)?${engine}(?:$|[\\s·(])`, 'i').test(settings.harness)) {
      route.availability = { state: 'setup', detail: `${route.availability?.detail ?? 'The route was found on this machine.'} Select its engine for this home with backbone engine ${engine}, then reopen the home before running it.` };
    } else if (route.kind === 'native-engine' && (settings.active?.kind !== 'native' || settings.hint)) {
      route.availability = { state: 'setup', detail: settings.hint ?? 'Choose a model for the installed Codex client in Settings or with backbone model codex --model <id>.' };
    }
  }
  return routes;
}
