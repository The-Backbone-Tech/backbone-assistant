import type { EngineCompaction, Turn } from '../api.ts';
import { createHash } from 'node:crypto';

/** Observations never alter the transcript, authority, effects or replay eligibility. */
export function recordCompaction(turn: Turn, event: EngineCompaction, historyTurnIds: string[], clean: (text: string) => string): void {
  const records = turn.work.compactions ??= [];
  const recordKey = createHash('sha256').update(JSON.stringify([event.engine, event.sessionId, event.id])).digest('hex');
  const prior = records.findIndex(record => record.recordKey === recordKey);
  if (prior < 0 && records.length >= 128) throw new Error('Too many compactions in one turn.');
  // One anchor opens the intact earlier conversation. Copying every prior ID into every later
  // turn would make both storage and rendered links grow quadratically in a long thread.
  const historyStart = historyTurnIds.length ? historyTurnIds.slice(0, 1) : [];
  const summary = event.summary !== undefined ? clean(event.summary) : undefined;
  const summaryTruncated = event.summaryTruncated === true || (summary?.length ?? 0) > 200_000;
  const record: EngineCompaction = {
    id: clean(event.id).slice(0, 512), recordKey, engine: event.engine, status: clean(event.status).slice(0, 80), historyTurnIds: historyStart,
    ...(event.sessionId ? { sessionId: clean(event.sessionId).slice(0, 512) } : {}),
    ...(summary !== undefined ? { summary: summary.slice(0, 200_000) } : {}),
    ...(summaryTruncated ? { summaryTruncated: true } : {}),
    ...(event.error !== undefined ? { error: clean(event.error).slice(0, 4000) } : {}),
    ...(event.estimated !== undefined ? { estimated: event.estimated } : {}),
  };
  for (const key of ['contextBefore', 'contextAfter'] as const) if (Number.isSafeInteger(event[key]) && event[key]! >= 0) record[key] = event[key];
  // Copy declared fields only: an engine payload may carry additional unredacted data at runtime.
  if (event.usage && [event.usage.input, event.usage.output].every(n => Number.isSafeInteger(n) && n >= 0)) record.usage = { input: event.usage.input, output: event.usage.output };
  // A display/storage limit must never turn a partial summary into reusable model context.
  if (!summaryTruncated && event.engine === 'pi' && event.replay && Number.isSafeInteger(event.replay.messages) && event.replay.messages > 0 && /^[a-f0-9]{64}$/.test(event.replay.sha256)) record.replay = { messages: event.replay.messages, sha256: event.replay.sha256 };
  if (prior < 0) records.push(record); else records[prior] = record;
}
