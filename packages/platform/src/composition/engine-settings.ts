import { governedPolicy, engineDecision, harnessDecision, PolicyRefused } from '../policy/index.ts';
// One selection rule for Host startup and diagnostics; the home setting is also the app's setting.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineChoices, EngineOption, Receipt } from '../api.ts';
import { readJson, writeJson } from '../stub/fsx.ts';
import { ACP_PROCESS_VISIBILITY_REFUSAL, HARNESSES, acpConfiguration, hostToolsOnly } from './harnesses.ts';
import { PIECES, pieceOnDisk } from './pieces.ts';
import { assertHomeWriteAdmission, withHomeLock } from './home-lock.ts';

const ALIASES: Record<string, string> = { pi: 'harness-pi', codex: 'harness-codex', acp: 'harness-acp', stub: 'harness-stub' };
export function engineId(name: string): string {
  const id = ALIASES[name] ?? name;
  if (id !== 'harness-stub' && id !== 'scripted' && !HARNESSES[id]) throw new Error('Choose an engine: pi, codex, acp or stub.');
  return id;
}
export function selectedHarness(home: string, fallback = 'harness-stub', env: NodeJS.ProcessEnv = process.env): string {
  const personal = env.BACKBONE_HARNESS ?? readJson<{ harness?: string }>(join(home, 'settings.json'), {}).harness;
  return harnessDecision(governedPolicy(home), personal === undefined ? undefined : engineId(personal), engineId(fallback));
}
export const engineLabel = (id: string): string => ({ 'harness-pi': 'Pi', 'harness-codex': 'Codex (installed client)', 'harness-acp': 'ACP (configured agent)', 'harness-stub': 'Stub harness (no model called)', scripted: 'Scripted harness (no model called)' })[id] ?? id;

export async function setEngine(home: string, name: string, changed: () => void): Promise<Receipt<{ engine: string; detail: string }>> {
  let engine: string;
  try { engine = engineId(name); } catch (e) { return { ok: false, outcome: 'REFUSED', reason: 'INVALID', detail: (e as Error).message }; }
  // A policy refusal before the write is definite: it is returned as a refusal with the policy's reason,
  // so a person is not told the outcome is unknown. Anything else still propagates as it did.
  const policyRefusal = (error: unknown): Receipt<never> => {
    if (error instanceof PolicyRefused) return { ok: false, outcome: 'REFUSED', reason: 'NOT_AVAILABLE', detail: error.message };
    throw error;
  };
  try { engineDecision(governedPolicy(home), engine); } catch (error) { return policyRefusal(error); }
  return withHomeLock(home, async () => {
    try { engineDecision(governedPolicy(home), engine); } catch (error) { return policyRefusal(error); }
    const path = join(home, 'settings.json');
    const stored = readJson<Record<string, unknown>>(path, {});
    assertHomeWriteAdmission(home);
    writeJson(path, { ...stored, harness: engine });
    changed();
    return { ok: true, value: { engine, detail: `Saved ${engineLabel(engine)} for the next process opening this data folder. Restart an app or daemon already holding it. BACKBONE_HARNESS overrides this choice.` } };
  });
}

const OPTIONS: { name: EngineOption['name']; id: string; label: string; about: string }[] = [
  { name: 'pi', id: 'harness-pi', label: 'Pi', about: 'Runs on the model you choose below, with this app’s own tools and the permissions you give here. Colleagues can be answered on the same engine.' },
  { name: 'codex', id: 'harness-codex', label: 'Codex', about: 'Runs inside the Codex app installed on this computer, with its own tools, sign-in and plan. Colleagues are then answered by the shared-work model below.' },
  { name: 'acp', id: 'harness-acp', label: 'Claude or your own agent (ACP)', about: 'Runs the agent you set up below, which brings its own model, tools, sign-in and billing. Colleagues are then answered by the shared-work model below.' },
  { name: 'stub', id: 'harness-stub', label: 'Practice', about: 'Answers with fixed practice text. No model is called and nothing is billed.' },
];
const POLICY_REFUSED = 'Your organisation’s managed policy does not allow this engine.';

/**
 * Every engine Settings can offer, with whether it can run on this computer. Nothing is started, signed
 * in or written: Codex is asked only for its sign-in status, as the doctor does. A refused engine stays
 * listed with the policy as its reason, so a person sees what the policy allows instead of a gap.
 */
type Check = { status: 'ok' | 'warn' | 'fail'; detail: string };
/**
 * A display check that runs once at a time and is reused briefly: a second request while one runs joins
 * it, an answer is reused for `ms`, and `fresh` (Check again) asks anew unless one is already running.
 * Only Settings' engine list uses this; admission and billing keep their own fresh checks.
 */
export function settingsCheck<T>(probe: () => Promise<T>, ms: number, now: () => number = Date.now): (fresh?: boolean) => Promise<T> {
  let running: Promise<T> | undefined, last: { at: number; value: T } | undefined;
  return (fresh = false) => {
    if (running) return running;
    if (!fresh && last && now() - last.at < ms) return Promise.resolve(last.value);
    running = probe().then((value) => { last = { at: now(), value }; return value; }).finally(() => { running = undefined; });
    return running;
  };
}

export async function engineChoices(home: string, running: string, deps: { fallback?: string; env?: NodeJS.ProcessEnv; codex: () => Promise<Check>; pieceDir: (id: string) => string }): Promise<EngineChoices> {
  const env = deps.env ?? process.env, fallback = deps.fallback ?? 'harness-stub';
  let policy: ReturnType<typeof governedPolicy>, policyFailed = false;
  try { policy = governedPolicy(home); } catch { policyFailed = true; }
  let next: string | null;
  try { next = selectedHarness(home, fallback, env); } catch { next = null; }
  const settings = readJson<{ harness?: unknown; harnesses?: Record<string, unknown> }>(join(home, 'settings.json'), {});
  let stored: string | null = null;
  try { if (typeof settings.harness === 'string') stored = engineId(settings.harness); } catch { stored = null; }
  // Asked only when Codex could be offered, and without blocking this process.
  const codex = !policyFailed && existsSync(deps.pieceDir('harness-codex')) && (() => { try { engineDecision(policy, 'harness-codex'); return true; } catch { return false; } })() ? await deps.codex() : undefined;
  const why = (id: string): string | undefined => {
    if (id === 'harness-stub') return undefined;
    if (!existsSync(deps.pieceDir(id))) return `${OPTIONS.find((o) => o.id === id)!.label} is not included in this installation.`;
    if (id === 'harness-codex') {
      const check = codex!;
      if (check.status === 'ok') return undefined;
      return /absent$/.test(check.detail) ? 'Codex is not installed on this computer. Install it and sign in through Codex itself, then check again.'
        : /signed out$/.test(check.detail) ? 'Codex is installed but not signed in. Sign in through Codex itself, then check again.'
        : 'Codex could not be checked. Open Codex to make sure it works, then check again.';
    }
    if (id === 'harness-acp') {
      const value = settings.harnesses?.['harness-acp'];
      if (!value) return 'No agent is set up yet. Set one up under Change your model › Claude or your own agent, then choose it here.';
      try {
        const blocked = acpConfiguration(home, value, env).blocked;
        return blocked === ACP_PROCESS_VISIBILITY_REFUSAL ? 'The agent set up here has not been accepted. Resolve and accept it under Change your model › Claude or your own agent.' : blocked;
      } catch (error) { return `The agent set up here cannot run: ${(error as Error).message}`; }
    }
    return undefined;
  };
  const options = OPTIONS.map(({ name, id, label, about }): EngineOption => {
    let refused = policyFailed;
    if (!refused) try { engineDecision(policy, id); } catch { refused = true; }
    if (refused) return { id, name, label, about, state: 'refused', reason: policyFailed ? 'The managed policy could not be checked, so no engine can be chosen here.' : POLICY_REFUSED };
    const reason = why(id);
    return reason ? { id, name, label, about, state: 'unavailable', reason } : { id, name, label, about, state: 'available' };
  });
  return { running, next, stored, environment: env.BACKBONE_HARNESS !== undefined, options };
}

/**
 * True when the engine chosen for this data folder brings its own tools, so the shared service refuses
 * colleagues' messages (a colleague's narrower permission cannot be enforced on those tools). This is the
 * one fact the service's refusal uses; the app and the command line read it to tell the owner in advance.
 */
export function engineBringsOwnTools(home: string, fallback = 'harness-pi', env: NodeJS.ProcessEnv = process.env): boolean {
  const id = selectedHarness(home, fallback, env);
  return !hostToolsOnly(id, HARNESSES[id] ? pieceOnDisk(PIECES[id].dir, PIECES[id].id).manifest : undefined);
}
