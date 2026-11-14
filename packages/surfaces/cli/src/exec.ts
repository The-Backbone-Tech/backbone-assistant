// Headless output observes the ordinary send path. It never retries a send or grants authority.
import { readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import type { Turn, WorkStep } from '@backbone-next/platform';
import { EXIT, type Io, type Parsed } from './commands.ts';

type StepItem = { id: string; type: 'backbone_step'; status: 'in_progress' | 'completed'; kind: WorkStep['kind']; text: string };
type MessageItem = { id: string; type: 'agent_message'; text: string };
type EffectItem = { id: string; type: 'backbone_effect'; kind: string; target: string; outcome: 'DONE' | 'REFUSED' | 'UNKNOWN'; detail?: string };
export type ExecEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started'; turn_id: string }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item: StepItem | MessageItem | EffectItem }
  | { type: 'turn.completed'; usage: { input_tokens: number; cached_input_tokens: null; output_tokens: number } | null; structured_output?: unknown }
  | { type: 'turn.failed'; error: { message: string }; exit_code: number };

/** Draft-07, local references only. Compile before opening a home or starting any work. */
function outputSchema(file: string): { schema: object | boolean; validate: ValidateFunction } {
  let contents: string;
  try { contents = readFileSync(file, 'utf8'); }
  catch { throw new Error('Cannot read the output schema file.'); }
  let schema: unknown;
  // Parser and compiler diagnostics can contain bytes from a mistakenly selected private file.
  try { schema = JSON.parse(contents); }
  catch { throw new Error('The output schema file must contain valid JSON.'); }
  if (schema === null || (typeof schema !== 'object' && typeof schema !== 'boolean') || Array.isArray(schema)) throw new Error('expected a JSON Schema object or boolean');
  const ajv = new Ajv({ strict: true, allErrors: true, validateFormats: true });
  try { return { schema, validate: ajv.compile(schema) }; }
  catch { throw new Error('Invalid or unsupported draft-07 schema; references must stay within this document.'); }
}

export async function runExec(parsed: Parsed, io: Io, send: (parsed: Parsed, io: Io) => Promise<number>): Promise<number> {
  const emit = (event: ExecEvent) => { if (parsed.json) io.out(JSON.stringify(event)); };
  const fail = (code: number, message: string) => {
    emit({ type: 'turn.failed', error: { message }, exit_code: code });
    return code;
  };
  let output: ReturnType<typeof outputSchema> | undefined;
  try { if (parsed.options.outputSchema !== undefined) output = outputSchema(parsed.options.outputSchema); }
  catch (error) {
    const message = `Invalid output schema: ${(error as Error).message}`;
    io.err(message); return fail(EXIT.USAGE, message);
  }
  const prompt = output ? `${parsed.target}\n\nReturn the final answer as JSON matching this JSON Schema, without Markdown fences:\n${JSON.stringify(output.schema)}` : parsed.target;
  let final: Turn | undefined;
  const steps = new Map<number, StepItem>();
  const errors: string[] = [];
  let started = false;
  let code: number;
  try {
    code = await send({ ...parsed, name: 'send', json: true, target: prompt }, {
      ...io,
      // The legacy send value is retained for its consumers; exec has its own projection.
      out: () => {},
      err: text => { errors.push(text); io.err(text); },
      turn: {
        started(threadId, turnId) {
          started = true;
          emit({ type: 'thread.started', thread_id: threadId });
          emit({ type: 'turn.started', turn_id: turnId });
        },
        updated(turn) {
          for (const [index, step] of turn.work.steps.entries()) {
            const previous = steps.get(index);
            const item: StepItem = { id: `step_${index}`, type: 'backbone_step', status: 'in_progress', kind: step.kind, text: step.label };
            if (!previous || previous.text !== item.text || previous.kind !== item.kind) {
              emit({ type: previous ? 'item.updated' : 'item.started', item });
              steps.set(index, item);
            }
          }
        },
        ended(turn) { final = turn; },
      },
    });
  } catch (error) {
    // A lost observation after admission cannot establish that an effect did not happen.
    const message = (error as Error).message;
    io.err(message); return fail(started ? EXIT.UNKNOWN : EXIT.REFUSED, message);
  }
  if (final && final.status !== 'running') {
    for (const item of steps.values()) emit({ type: 'item.completed', item: { ...item, status: 'completed' } });
  }
  if (final) {
    for (const [index, effect] of final.effects.entries()) {
      emit({ type: 'item.completed', item: { id: `effect_${index}`, type: 'backbone_effect', kind: effect.kind, target: effect.target, outcome: effect.outcome, ...(effect.detail ? { detail: effect.detail } : {}) } });
    }
    if (final.answer && final.status !== 'refused' && !final.withheld) {
      emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: final.answer.text } });
      if (!parsed.json) io.out(final.answer.text);
    }
  }
  if (code !== EXIT.OK) return fail(code, errors.join('\n') || 'The turn did not complete.');
  if (!final?.answer || final.withheld) return fail(EXIT.FAILED, 'No available final answer.');
  let structured: unknown;
  if (output) {
    try {
      structured = JSON.parse(final.answer.text);
      if (!output.validate(structured)) throw new Error(new Ajv().errorsText(output.validate.errors));
    } catch (error) {
      const message = `Final answer does not match the output schema: ${(error as Error).message}`;
      io.err(message); return fail(EXIT.FAILED, message);
    }
  }
  const usage = final.work.usage;
  emit({ type: 'turn.completed', usage: usage ? { input_tokens: usage.input, cached_input_tokens: null, output_tokens: usage.output } : null, ...(output ? { structured_output: structured } : {}) });
  return EXIT.OK;
}
