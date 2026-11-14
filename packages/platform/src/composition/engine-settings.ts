import { governedPolicy, engineDecision, harnessDecision } from '../policy/index.ts';
// One selection rule for Host startup and diagnostics; the home setting is also the app's setting.
import { join } from 'node:path';
import type { Receipt } from '../api.ts';
import { readJson, writeJson } from '../stub/fsx.ts';
import { HARNESSES } from './harnesses.ts';
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
  engineDecision(governedPolicy(home), engine);
  return withHomeLock(home, async () => {
    engineDecision(governedPolicy(home), engine);
    const path = join(home, 'settings.json');
    const stored = readJson<Record<string, unknown>>(path, {});
    assertHomeWriteAdmission(home);
    writeJson(path, { ...stored, harness: engine });
    changed();
    return { ok: true, value: { engine, detail: `Saved ${engineLabel(engine)} for the next process opening this home. Restart an app or daemon already holding it. BACKBONE_HARNESS overrides this choice.` } };
  });
}
