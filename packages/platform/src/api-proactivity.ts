/** A trusted local program, launched without a shell or inherited provider credentials.
 * Exit 0 means quiet, 10 means wake, any other exit means failure. Full local chat permission only.
 * This program runs with the person's OS rights, so use a read-only check, never an outside write.
 */
export interface WakeGate { command: string; args: string[]; timeoutMs?: number }
/** A gate in flight at process interruption is never executed again automatically. */
export type WakeGateState = 'checking' | 'quiet' | 'wake' | 'failed';
/** Opt in to Standard Webhooks with JSON object/array bodies. The operator supplies the HTTPS relay. */
export interface SignedWebhook { authentication: 'standard'; publicOrigin?: string; permission?: 'ask' | 'auto-review' }
/** Installed by trusted admission, never accepted from a sender's body or turns.send arguments. */
export interface ExternalTriggerAuthority { triggerId: string; origin: string; permission: 'ask' | 'auto-review' }
export interface TriggerIngress {
  webhook?: SignedWebhook;
  /** The local relay destination; credentials are never part of either URL. */
  localUrl?: string;
}

/** API-line and MCP clients get schedule state, not person-side program configuration. */
export function redactWakeGates(view: import('./api.ts').Proactivity): import('./api.ts').Proactivity {
  const result = structuredClone(view);
  for (const schedule of [...result.schedules, ...(result.heartbeat ? [result.heartbeat] : [])]) {
    if (schedule.wakeGate) { delete schedule.wakeGate; schedule.hasWakeGate = true; }
  }
  return result;
}
