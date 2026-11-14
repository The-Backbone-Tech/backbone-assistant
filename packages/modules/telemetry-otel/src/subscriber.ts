import type { ApiEvent, Args, Method, Result, Turn, GoalRun, ScheduleRun } from '@backbone-next/platform';
import type { TelemetryObservation } from '@backbone-next/platform/ports/telemetry';
import { createExporter, opaque, turnContext, type ExportOptions } from './exporter.ts';
import { A, type SafeAttributes } from './conventions.ts';

export interface TelemetryHost {
  call<M extends Method>(method: M, args: Args<M>): Promise<Result<M>>;
  on(listener: (event: ApiEvent) => void): () => void;
}
export interface TelemetryOptions extends Omit<ExportOptions, 'endpoint'> {
  endpoint?: string;
  observe?: (listener: (event: TelemetryObservation) => void) => () => void;
  /** Trusted composition detaches subscriber reads from the emitting operation's lock scope. */
  dispatch?: (task: () => void) => void;
}
const turnOutcome = (turn: Turn) => turn.effects.some(e => e.outcome === 'UNKNOWN') ? 'unknown'
  : turn.failure ? 'failed' : turn.interrupted || turn.status === 'stopped' ? 'interrupted'
  : turn.refusal || turn.status === 'refused' ? 'refused' : 'done';

/** Subscribe without extending Host authority. Only small safe projections survive a callback. */
export function startTelemetry(host: TelemetryHost, options: TelemetryOptions) {
  if (!options.endpoint) return undefined;
  const exporter = createExporter({ ...options, endpoint: options.endpoint });
  const since = Date.now();
  const seen = new Map<string, number>();
  const metadata = new Map<string, SafeAttributes>();
  const pending = new Set<string>();
  const unfinished = new Set<string>();
  let schedules = false, closed = false, draining: Promise<void> | undefined, scheduled = false;
  const reading = new Set<string>();
  let readingSchedules = false;
  let oldest = since;
  const remember = (key: string, at: number) => {
    seen.set(key, at);
    if (seen.size > 2048) { const first = seen.keys().next().value!; oldest = Math.max(oldest, seen.get(first)!); seen.delete(first); exporter.stats.dropped++; }
  };
  const fresh = (key: string, at: number) => at >= oldest && !seen.has(key);
  const ids = (threadId: string, turnId: string): SafeAttributes => ({ [A.thread]: threadId, [A.turn]: turnId });
  const observe = (event: TelemetryObservation) => {
    if (closed) return;
    try {
      if (event.kind === 'turn') {
        if (metadata.size >= 512 && !metadata.has(event.turnId)) { metadata.delete(metadata.keys().next().value!); exporter.stats.dropped++; }
        metadata.set(event.turnId, { [A.run]: event.runId, [A.engine]: event.engineId, [A.route]: event.routeId });
      } else if (event.kind === 'tool') {
        exporter.emit('tool', event.startedAt, event.endedAt, { ...ids(event.threadId,event.turnId), ...metadata.get(event.turnId), [A.tool]: event.tool, [A.outcome]: event.outcome }, turnContext(event.threadId,event.turnId));
      } else {
        const at = event.at;
        exporter.emit('effect', at, at, { ...(event.threadId && event.turnId ? ids(event.threadId,event.turnId) : {}), [A.effect]: event.effectId, [A.phase]: event.phase, [A.outcome]: event.outcome }, event.threadId && event.turnId ? turnContext(event.threadId,event.turnId) : undefined);
      }
    } catch { exporter.stats.dropped++; }
  };
  const stopObservations = options.observe?.(observe);
  const goal = (run: GoalRun) => {
    const at = Date.parse(run.startedAt), key = `goal:${run.threadId}:${run.startedAt}:${run.status}`;
    if (run.status === 'running' || !fresh(key, Date.parse(run.updatedAt))) return;
    remember(key,at);
    exporter.emit('goal',at,Date.parse(run.updatedAt), { [A.thread]: run.threadId, [A.run]: opaque(`${run.threadId}:${run.startedAt}`), [A.turns]: run.used, [A.outcome]: run.status === 'met' ? 'done' : run.status === 'interrupted' ? 'interrupted' : 'held' });
  };
  const scheduleRun = (run: ScheduleRun) => {
    const at = Date.parse(run.startedAt), key = `schedule:${run.id}`;
    if (!run.endedAt || !fresh(key,Date.parse(run.endedAt))) return;
    remember(key,at);
    exporter.emit('schedule',at,Date.parse(run.endedAt), { [A.run]: run.id,
      ...(run.threadId && run.turnId ? ids(run.threadId,run.turnId) : {}),
      [A.outcome]: run.outcome === 'failed' ? 'failed' : run.outcome === 'interrupted' || run.outcome === 'stopped' ? 'interrupted' : ['needs-you','emergency','skipped'].includes(run.outcome) ? 'held' : 'done' }, run.threadId && run.turnId ? turnContext(run.threadId,run.turnId) : undefined);
  };
  const drain = async () => {
    while (!closed && (pending.size || schedules)) {
      if (pending.size) {
        const id = pending.values().next().value!; pending.delete(id);
        reading.add(id);
        try {
          const projection = await host.call('threads.get',{id});
          if (!projection.ok || closed) continue;
          const thread = projection.value;
          if ([...thread.turns, ...thread.sideTurns].some(turn => turn.status === 'running')) {
            if (unfinished.size < 128 || unfinished.has(id)) unfinished.add(id);
            else exporter.stats.dropped++;
          } else unfinished.delete(id);
          for (const turn of [...thread.turns, ...thread.sideTurns]) {
            const at = Date.parse(turn.work.startedAt), key = `turn:${turn.id}`;
            if (turn.status === 'running' || seen.has(key) || (at < oldest && !metadata.has(turn.id))) continue;
            remember(key,at);
            exporter.emit('turn',at,Date.parse(turn.work.endedAt ?? turn.work.startedAt), { ...ids(id,turn.id), ...metadata.get(turn.id),
              [A.steps]: turn.work.steps.length, [A.outcome]: turnOutcome(turn),
              ...(turn.work.usage ? { [A.inputTokens]: turn.work.usage.input, [A.outputTokens]: turn.work.usage.output } : {}),
            }, undefined, turnContext(id,turn.id));
            metadata.delete(turn.id);
          }
          if (thread.goalRun) goal(thread.goalRun);
        } catch { if (!closed) exporter.stats.dropped++; }
        finally { reading.delete(id); }
      } else if (schedules) {
        schedules = false;
        readingSchedules = true;
        try { const projection = await host.call('schedules.get',{}); if (!closed) for (const run of projection.runs) scheduleRun(run); }
        catch { if (!closed) exporter.stats.dropped++; }
        finally { readingSchedules = false; }
      }
    }
  };
  const schedule = () => {
    if (scheduled || draining || closed) return;
    scheduled = true;
    (options.dispatch ?? (fn => fn()))(() => {
      setImmediate(() => {
        scheduled = false;
        if (closed) return;
        draining = drain().finally(() => { draining = undefined; if (pending.size || schedules) schedule(); });
      }).unref();
    });
  };
  const stopEvents = host.on(event => {
    // This synchronous callback cannot throw into Host.emit. No content enters the pending queue.
    try {
      if (closed) return;
      if ((event.topic === 'threads' || event.topic === 'goals') && event.id) {
        if (pending.size >= 128 && !pending.has(event.id)) exporter.stats.dropped++;
        else pending.add(event.id);
      }
      if (event.topic === 'schedules') schedules = true;
      schedule();
    } catch { exporter.stats.dropped++; }
  });
  const flush = async () => {
    if (scheduled) await new Promise<void>(r => setImmediate(r));
    while (draining) await draining;
    if (pending.size || schedules) await drain();
    await exporter.flush();
  };
  let closing: Promise<void> | undefined;
  return {
    stats: exporter.stats,
    /** Explicit diagnostic/test barrier. Work never calls this. */
    flush,
    close() {
      if (closing) return closing;
      closing = (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          try { stopEvents(); } catch { exporter.stats.dropped++; }
          try { stopObservations?.(); } catch { exporter.stats.dropped++; }
          // A healthy collector gets the final root, including short CLI turns. A stuck projection
          // or collector cannot extend shutdown beyond one request deadline.
          const finish = async () => {
            await flush();
            // A caller can see a terminal turn before Host publishes its final event. Refresh
            // after any in-flight read too: it may have captured the still-running projection.
            for (const id of unfinished) if (pending.size < 128 || pending.has(id)) pending.add(id);
            await flush();
          };
          await Promise.race([finish(), new Promise<void>(resolve => { timer = setTimeout(resolve, exporter.timeoutMs); })]);
        } catch { exporter.stats.dropped++; }
        finally {
          clearTimeout(timer); closed = true;
          // These observations have not reached the exporter queue yet. Count abandoned
          // projections as loss too, including a read already removed from pending.
          exporter.stats.dropped += new Set([...pending, ...reading, ...unfinished]).size + Number(schedules || readingSchedules);
          pending.clear(); unfinished.clear(); schedules = false; metadata.clear(); seen.clear();
          try { await exporter.close(); } catch { exporter.stats.dropped++; }
        }
      })();
      return closing;
    },
  };
}
