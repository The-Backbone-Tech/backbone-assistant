/** Optional content-free observations. No arguments, results, names or error details cross this port. */
export type TelemetryOutcome = 'done' | 'failed' | 'interrupted' | 'refused' | 'held' | 'unknown';
export const TELEMETRY_TOOLS = ['list', 'read', 'write', 'writeIfVersion', 'checkpoint', 'connectors', 'callConnector', 'startChild', 'awaitChild', 'proposeGoal', 'addCard', 'messageCard', 'searchMemory', 'proposeMemory', 'native_staged', 'native_subagent'] as const;
export type TelemetryTool = typeof TELEMETRY_TOOLS[number];
export type TelemetryPhase = 'proposed' | 'held' | 'released' | 'sent' | 'failed' | 'unknown' | 'discarded';
export type TelemetryObservation =
  | { kind: 'turn'; threadId: string; turnId: string; runId: string; engineId: string; routeId: string; at: number }
  | { kind: 'tool'; threadId: string; turnId: string; tool: TelemetryTool; startedAt: number; endedAt: number; outcome: TelemetryOutcome }
  | { kind: 'effect'; threadId?: string; turnId?: string; effectId: string; phase: TelemetryPhase; at: number; outcome: TelemetryOutcome };
