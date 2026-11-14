// Optional composition only. Diagnostics are fixed classes; no error text or credential is returned.
import { governedPolicy, PolicyRefused } from '../policy/index.ts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTelemetrySettings, resolveTelemetryHeaders, storedTelemetryHeaderCount } from '../credentials/telemetry.ts';
import type { HomeKeys } from '../keys/vault.ts';
import type { Host } from './host-types.ts';
import { subscribeTelemetry } from './telemetry-observations.ts';
import { outsideHomeLocks } from './home-lock.ts';

export type TelemetryStatus = { status: 'off' } | { status: 'on' } | { status: 'misconfigured'; reason: 'settings' | 'credentials' | 'module' | 'startup' };
export type TelemetryInspection = { status: 'off' } | { status: 'on'; storedHeaders: number } | { status: 'misconfigured'; reason: 'settings' | 'credentials' | 'module' };
const unavailable = (reason: Extract<TelemetryStatus, { status: 'misconfigured' }>['reason']): TelemetryStatus => ({ status: 'misconfigured', reason });
async function prepare(home: string, keys?: HomeKeys): Promise<{ state: TelemetryStatus; settings?: import('../credentials/telemetry.ts').TelemetrySettings; headers?: Record<string, string> }> {
  const required = governedPolicy(home)?.requirements.telemetryRequired === true;
  const failed = (reason: 'settings' | 'credentials') => { if (required) throw new PolicyRefused('requirement', `Required telemetry could not start (${reason}).`); return { state: unavailable(reason) }; };
  let settings;
  try { settings = readTelemetrySettings(home); } catch (error) { if (error instanceof PolicyRefused) throw error; return failed('settings'); }
  if (!settings) return { state: { status: 'off' } as TelemetryStatus };
  let headers;
  try { headers = await resolveTelemetryHeaders(home, keys); } catch { return failed('credentials'); }
  return { state: { status: 'on' } as TelemetryStatus, settings, headers };
}

/** Read-only configuration inspection: no keys, vault, SDK loading or collector probe. Applies on restart. */
export async function inspectTelemetryStatus(home: string): Promise<TelemetryInspection> {
  try {
    if (!readTelemetrySettings(home)) return { status: 'off' };
  } catch { return { status: 'misconfigured', reason: 'settings' }; }
  let storedHeaders: number;
  try { storedHeaders = storedTelemetryHeaderCount(home); }
  catch { return { status: 'misconfigured', reason: 'credentials' }; }
  try {
    if (!existsSync(fileURLToPath(import.meta.resolve('@backbone-next/telemetry-otel')))) return { status: 'misconfigured', reason: 'module' };
    return { status: 'on', storedHeaders };
  } catch { return { status: 'misconfigured', reason: 'module' }; }
}
const inactive = (state: TelemetryStatus) => ({ ...state, stats: { dropped: 0, exported: 0, queued: 0 }, async flush() {}, async close() {} });

type RunningTelemetry = { endpoint: string; runtime: { status: 'on'; endpoint: string; stats: { dropped: number; exported: number; queued: number }; flush(): Promise<void>; close(): Promise<void> } };
const running = new WeakMap<Host, RunningTelemetry>();
const starting = new WeakMap<Host, Promise<Awaited<ReturnType<typeof startUncached>>>>();
/** One exporter per Host, shared by startup admission and the owning surface. */
export async function startConfiguredTelemetry(host: Host, home: string, keys?: HomeKeys) {
  const prior = starting.get(host);
  if (prior) return prior;
  const next = startUncached(host, home, keys);
  starting.set(host, next);
  try { return await next; } finally { if (starting.get(host) === next) starting.delete(host); }
}
async function startUncached(host: Host, home: string, keys?: HomeKeys) {
  const required = governedPolicy(home)?.requirements.telemetryRequired === true;
  const failed = (reason: 'module' | 'startup') => { if (required) throw new PolicyRefused('requirement', `Required telemetry could not start (${reason}).`); return inactive(unavailable(reason)); };
  const prepared = await prepare(home, keys);
  if (!prepared.settings || !prepared.headers) return inactive(prepared.state);
  const existing = running.get(host);
  if (existing) {
    if (existing.endpoint !== prepared.settings.endpoint) throw new PolicyRefused('requirement', 'The running telemetry destination changed; restart this Host before governed work.');
    return existing.runtime;
  }
  let startTelemetry: typeof import('@backbone-next/telemetry-otel')['startTelemetry'];
  try { ({ startTelemetry } = await import('@backbone-next/telemetry-otel')); }
  catch { return failed('module'); }
  try {
    if (readTelemetrySettings(home)?.endpoint !== prepared.settings.endpoint) throw new PolicyRefused('requirement', 'Telemetry configuration changed during startup; restart this Host.');
    const runtime = startTelemetry(host, { endpoint: prepared.settings.endpoint, headers: prepared.headers, observe: listener => subscribeTelemetry(home, listener), dispatch: task => outsideHomeLocks(task) });
    if (!runtime) return failed('startup');
    const shared = { ...runtime, status: 'on' as const, endpoint: prepared.settings.endpoint, async close() { running.delete(host); await runtime.close(); } };
    running.set(host, { endpoint: prepared.settings.endpoint, runtime: shared });
    return shared;
  } catch (error) { if (error instanceof PolicyRefused) throw error; return failed('startup'); }
}
