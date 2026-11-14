// Trusted, optional observation bus. No observer can throw into work or retain tool content.
import { createHash } from 'node:crypto';
import { canonicalHome } from '../doors/protocol.ts';
import type { HeldCall } from '../api.ts';
import { TELEMETRY_TOOLS, type TelemetryObservation, type TelemetryOutcome, type TelemetryPhase } from '../ports/telemetry.ts';
import type { HarnessEvent, ToolHost } from '../ports/harness.ts';

const listeners = new Map<string, Set<(event: TelemetryObservation) => void>>();
export function subscribeTelemetry(home: string, listener: (event: TelemetryObservation) => void): () => void {
  const key = canonicalHome(home), set = listeners.get(key) ?? new Set();
  set.add(listener); listeners.set(key, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}
export function publishTelemetry(home: string, event: TelemetryObservation): void {
  if (!listeners.size) return;
  for (const listener of listeners.get(canonicalHome(home)) ?? []) {
    try {
      const result: unknown = listener(event);
      if (result instanceof Promise) void result.catch(() => {});
    } catch { /* Observers have no authority over work. */ }
  }
}
export function observeEffect(home: string, held: Pick<HeldCall, 'effect' | 'threadId' | 'turnId'>, phase: TelemetryPhase, outcome?: TelemetryOutcome): void {
  if (!listeners.size || !listeners.has(canonicalHome(home))) return;
  publishTelemetry(home, { kind: 'effect', effectId: held.effect, threadId: held.threadId, turnId: held.turnId, phase, at: Date.now(),
    outcome: outcome ?? (phase === 'held' || phase === 'proposed' || phase === 'released' ? 'held' : phase === 'discarded' ? 'refused' : phase === 'sent' ? 'done' : phase) });
}
const outcomeOf = (result: unknown): TelemetryOutcome => {
  if (result && typeof result === 'object' && 'outcome' in result) {
    const value = (result as {outcome: unknown}).outcome;
    if (value === 'REFUSED') return 'refused';
    if (value === 'UNKNOWN') return 'unknown';
    if (value === 'HELD') return 'held';
    if (value === 'SENT' && 'state' in result && (result.state === 'failed' || result.state === 'unknown')) return result.state;
  }
  return 'done';
};
/** Wrap only the platform's fixed catalogue; connector names and all argument/result bytes stay here. */
export function observeTools(home: string | undefined, threadId: string, turnId: string, tools: ToolHost): ToolHost {
  if (!listeners.size || !home || !listeners.has(canonicalHome(home))) return tools;
  return new Proxy(tools, { get(target, key, receiver) {
    const method = Reflect.get(target, key, receiver);
    if (typeof key !== 'string' || !TELEMETRY_TOOLS.includes(key as never) || typeof method !== 'function') return method;
    return (...args: unknown[]) => {
      const startedAt = Date.now();
      const report = (outcome: TelemetryOutcome) => publishTelemetry(home, { kind: 'tool', threadId, turnId, tool: key as typeof TELEMETRY_TOOLS[number], startedAt, endedAt: Date.now(), outcome });
      try {
        const result: unknown = Reflect.apply(method, target, args);
        if (result instanceof Promise) return result.then(value => { report(outcomeOf(value)); return value; }, error => { report('failed'); throw error; });
        report(outcomeOf(result)); return result;
      } catch (error) { report('failed'); throw error; }
    };
  } });
}

type NativeToolEvent = Pick<Extract<HarnessEvent, { type: 'tool' }>, 'id' | 'tool' | 'phase'>;
/** Native labels stay with the work record. A missing or evicted proposal yields a completion point. */
export function observeNativeTools(home: string | undefined, threadId: string, turnId: string): (event: NativeToolEvent) => void {
  const active = new Map<string, number>();
  return event => {
    try {
      if (!listeners.size || !home || !listeners.has(canonicalHome(home))) return;
      if (event.tool !== 'native_staged' && event.tool !== 'native_subagent') return;
      if (!['proposed', 'done', 'refused', 'unknown'].includes(event.phase)) return;
      const at = Date.now();
      // Engine IDs may contain content. Only their digest survives this callback, never their bytes.
      const key = event.id ? createHash('sha256').update(event.tool).update('\0').update(event.id).digest('hex') : undefined;
      if (event.phase === 'proposed') {
        if (!key || active.has(key)) return;
        if (active.size >= 128) active.delete(active.keys().next().value!);
        active.set(key, at);
        return;
      }
      const startedAt = key ? active.get(key) ?? at : at;
      if (key) active.delete(key);
      publishTelemetry(home, { kind: 'tool', threadId, turnId, tool: event.tool, startedAt, endedAt: at, outcome: event.phase });
    } catch { /* A malformed native event must never change the turn. */ }
  };
}
