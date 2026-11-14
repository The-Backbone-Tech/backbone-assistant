// Read 2026-11-10: OpenTelemetry GenAI conventions (Development), commit
// e6658f14c9d9ea0760825f029cb82e7673f48fab, docs/gen-ai/{gen-ai-agent-spans,client-inference}.md.
// https://github.com/open-telemetry/semantic-conventions-genai/tree/e6658f14c9d9ea0760825f029cb82e7673f48fab
// Names and the complete export allowlist live here. Content conventions are deliberately absent.
export const A = {
  service: 'service.name',
  operation: 'gen_ai.operation.name',
  tool: 'gen_ai.tool.name',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  thread: 'backbone.thread.id',
  turn: 'backbone.turn.id',
  run: 'backbone.run.id',
  effect: 'backbone.effect.id',
  engine: 'backbone.engine.id',
  route: 'backbone.route.id',
  outcome: 'backbone.outcome',
  phase: 'backbone.effect.phase',
  steps: 'backbone.step.count',
  turns: 'backbone.turn.count',
  dropped: 'backbone.telemetry.dropped',
} as const;
export const ATTRIBUTES = Object.values(A);
export type Attribute = typeof ATTRIBUTES[number];
export type SafeAttributes = Partial<Record<Attribute, string | number>>;
export const OPERATIONS = { turn: 'invoke_agent', tool: 'execute_tool', effect: 'effect', goal: 'goal', schedule: 'schedule' } as const;
export const OUTCOMES = ['done', 'failed', 'interrupted', 'refused', 'held', 'unknown'] as const;
export const TOOLS = ['list', 'read', 'write', 'writeIfVersion', 'checkpoint', 'connectors', 'callConnector', 'startChild', 'awaitChild', 'proposeGoal', 'addCard', 'messageCard', 'searchMemory', 'proposeMemory', 'native_staged', 'native_subagent'] as const;
export const EFFECT_PHASES = ['proposed', 'held', 'released', 'sent', 'failed', 'unknown', 'discarded'] as const;
