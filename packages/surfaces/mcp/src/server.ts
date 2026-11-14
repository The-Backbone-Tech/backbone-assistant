import { SOLUTIONS_OPTIONS, SOLUTIONS_RUN, SOLUTIONS_VERIFY } from './selection-tools.ts';
// The MCP door: a thin adapter from MCP tool calls to the platform's gateway port. It translates and
// holds no policy: the grant's mandate and the core decide, and every answer is the platform's
// receipt or refusal as it is. Only a DONE effect is reported as a successful call.
// The read tools go to the app's api line (docs/adr/0002-api-line.md). Selection run uses its separately
// confirmed path, capped at ask permission and identifying the client's self-reported name.
import { McpServer } from '@modelcontextprotocol/server';
import type { Args, GoalRun, Result, Thread, ThreadSummary } from '@backbone-next/platform';
import { memoryReferenceJson, redactWakeGates } from '@backbone-next/platform';
import { LOST_MID_CALL } from '@backbone-next/platform/doors';
import { attachApi } from '@backbone-next/platform/doors/api-line';
import type { EffectReceipt, Gateway, GatewayResult } from '@backbone-next/platform/gateway';
import { EFFECT_STATUS, LIST_GOALS, LIST_PROJECTS, LIST_RECEIPTS, LIST_SCHEDULES, LIST_THREADS, PROPOSE_EFFECT, READ_THREAD, RECALL_KNOWLEDGE, SEARCH_MEMORY, SEARCH_THREADS } from './tools.ts';

export const DOOR_NAME = 'backbone';
export const DOOR_VERSION = '0.0.0';

/** Outcomes a caller may treat as a call that went through; anything else is reported as an error, by every tool that returns a receipt. */
const NOT_AN_ERROR = new Set(['DONE', 'PENDING', 'AWAITING_DECISION']);
const receiptIsError = (r: EffectReceipt) => !NOT_AN_ERROR.has(r.outcome);

function answer<T>(result: GatewayResult<T>, isError: (value: T) => boolean = () => false) {
  const body = result.ok ? { ok: true, value: result.value, ...(result.notice ? { notice: result.notice } : {}) } : result;
  const lead = !result.ok
    ? `REFUSED (${result.reason}): ${result.detail}`
    : Array.isArray(result.value)
      ? `${result.value.length} item(s).`
      : 'outcome' in (result.value as object)
        ? `${(result.value as EffectReceipt).outcome}: ${(result.value as EffectReceipt).next}`
        : 'OK.';
  return {
    content: [{ type: 'text' as const, text: `${lead}\n${JSON.stringify(body, null, 2)}` }],
    structuredContent: body as unknown as Record<string, unknown>,
    isError: !result.ok || isError(result.value),
  };
}

/**
 * The gateway's call threw: the app holding the home's keys stopped with the call in flight. What
 * became of it is not known, so it is an error with outcome UNKNOWN, never a refusal (which would say
 * nothing was sent), and in fixed words.
 */
async function carried(call: () => Promise<ReturnType<typeof answer>>) {
  try {
    return await call();
  } catch {
    const body = { ok: false, outcome: 'UNKNOWN', reason: 'NOT_AVAILABLE', detail: LOST_MID_CALL };
    return { content: [{ type: 'text' as const, text: `UNKNOWN (NOT_AVAILABLE): ${LOST_MID_CALL}\n${JSON.stringify(body, null, 2)}` }], structuredContent: body, isError: true };
  }
}

/** The tools' api-line methods; selection run has its own named-client, ask-only confirmation. */
type ReadMethod = 'solutions.options' | 'solutions.verify' | 'solutions.run' | 'projects.list' | 'threads.list' | 'threads.get' | 'threads.search' | 'goals.runs' | 'schedules.get' | 'memory.search';
/** One open line to the app for one read or separately confirmed selection call. */
export interface ReadLine {
  call<M extends ReadMethod>(method: M, args: Args<M>): Promise<Result<M>>;
  close(): void;
}
/** Where the read tools go: a line to the app, or null when nothing serves one (the app is not running). */
export interface Reads {
  open(): Promise<ReadLine | null>;
}
/** The home's api line, opened afresh for each tool call, so the door follows the app as it comes and goes. */
export const readsOver = (home: string): Reads => ({ open: () => attachApi(home) as Promise<ReadLine | null> });

const NOT_READ = 'Nothing was read, so this says nothing about what the workspace holds.';
const NO_APP = 'The app that keeps this workspace is not running, or serves no reads to other programs.';
const LINE_LOST = 'The line to the app ended during this read.';

/** `incomplete`: some of it could not be read or was left out, in words; what is missing is not an absence. */
type Read<T> = { ok: true; value: T; incomplete?: string } | { ok: false; reason: string; detail: string };
class Unavailable extends Error {}
/** A line's answer as a read: a list or view as it is, a receipt's value, or its refusal. */
function asRead<T>(r: unknown): Read<T> {
  if (r && typeof r === 'object' && !Array.isArray(r) && typeof (r as { ok?: unknown }).ok === 'boolean') {
    const receipt = r as { ok: boolean; value?: T; reason?: string; detail?: string };
    return receipt.ok ? { ok: true, value: receipt.value as T } : { ok: false, reason: receipt.reason ?? 'REFUSED', detail: receipt.detail ?? '' };
  }
  return { ok: true, value: r as T };
}
function said<T>(read: Read<T>) {
  // After the Host's raw credential checks; both MCP representations must be visibly encoded.
  read = JSON.parse(memoryReferenceJson(read)) as Read<T>;
  const lead = read.ok
    ? `${Array.isArray(read.value) ? `${read.value.length} item(s).` : 'OK.'}${read.incomplete ? ` INCOMPLETE: ${read.incomplete}` : ''}`
    : read.reason === 'NOT_AVAILABLE' ? `UNAVAILABLE: ${read.detail} ${NOT_READ}` : `REFUSED (${read.reason}): ${read.detail}`;
  return {
    content: [{ type: 'text' as const, text: `${lead}\n${JSON.stringify(read, null, 2)}` }],
    structuredContent: read as unknown as Record<string, unknown>,
    isError: !read.ok,
  };
}
type Get = <M extends ReadMethod>(method: M, args: Args<M>) => Promise<Read<unknown>>;
/** One tool call's reads on one line. No app, a silent one, or a line that ended: unavailable, in fixed words. */
async function reading(reads: Reads, fn: (get: Get) => Promise<Read<unknown>>) {
  let line: ReadLine | null = null;
  try {
    line = await reads.open().catch(() => { throw new Unavailable(NO_APP); });
    if (!line) throw new Unavailable(NO_APP);
    const open = line;
    const get: Get = async (method, args) => {
      const answer = await open.call(method, args).catch(() => { throw new Unavailable(LINE_LOST); });
      return asRead(answer);
    };
    return said(await fn(get));
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    return said({ ok: false, reason: 'NOT_AVAILABLE', detail: error.message });
  } finally {
    line?.close();
  }
}

export function createDoorServer(gateway: Gateway, reads: Reads): McpServer {
  const server = new McpServer({ name: DOOR_NAME, version: DOOR_VERSION });

  server.registerTool(
    PROPOSE_EFFECT.name,
    {
      title: PROPOSE_EFFECT.title,
      description: PROPOSE_EFFECT.description,
      inputSchema: PROPOSE_EFFECT.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (a) => carried(async () => answer(await gateway.call('effects.propose', a), receiptIsError)),
  );
  server.registerTool(
    EFFECT_STATUS.name,
    { title: EFFECT_STATUS.title, description: EFFECT_STATUS.description, inputSchema: EFFECT_STATUS.inputSchema, annotations: { readOnlyHint: true } },
    (a) => carried(async () => answer(await gateway.call('effects.get', a), receiptIsError)),
  );
  server.registerTool(
    LIST_RECEIPTS.name,
    { title: LIST_RECEIPTS.title, description: LIST_RECEIPTS.description, inputSchema: LIST_RECEIPTS.inputSchema, annotations: { readOnlyHint: true } },
    (a) => carried(async () => answer(await gateway.call('effects.list', a))),
  );
  server.registerTool(
    RECALL_KNOWLEDGE.name,
    { title: RECALL_KNOWLEDGE.title, description: RECALL_KNOWLEDGE.description, inputSchema: RECALL_KNOWLEDGE.inputSchema, annotations: { readOnlyHint: true } },
    (a) => carried(async () => answer(await gateway.call('knowledge.recall', a))),
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const tool = <A>(spec: { name: string; title: string; description: string; inputSchema: unknown }, run: (get: Get, a: A) => Promise<Read<unknown>>) =>
    server.registerTool(spec.name, { title: spec.title, description: spec.description, inputSchema: spec.inputSchema as never, annotations: readOnly }, ((a: A) => reading(reads, (get) => run(get, a))) as never);

  tool(SOLUTIONS_OPTIONS, (get, a: Args<'solutions.options'>) => get('solutions.options', a));
  tool(SOLUTIONS_VERIFY, (get, a: Args<'solutions.verify'>) => get('solutions.verify', a));
  server.registerTool(SOLUTIONS_RUN.name, {
    title: SOLUTIONS_RUN.title, description: SOLUTIONS_RUN.description, inputSchema: SOLUTIONS_RUN.inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    const line = await reads.open().catch(() => null);
    if (!line) return said({ ok: false, reason: 'NOT_AVAILABLE', detail: NO_APP });
    try { return await carried(async () => {
      const result = await line.call('solutions.run', { ...a, settings: { ...a.settings, permission: 'ask' }, caller: { mcp: server.server.getClientVersion()?.name?.trim().slice(0, 60) || null } });
      const lead = result.ok ? result.value.detail : `${result.outcome}: ${result.detail}`;
      return { content: [{ type: 'text' as const, text: `${lead}\n${JSON.stringify(result, null, 2)}` }], structuredContent: result as unknown as Record<string, unknown>, isError: !result.ok || result.value.started === null };
    }); }
    finally { line.close(); }
  });
  tool(LIST_PROJECTS, (get) => get('projects.list', {}));
  tool(LIST_THREADS, async (get, a: { projectId?: string; archived?: boolean; limit?: number }) => {
    const all = await get('threads.list', {});
    if (!all.ok) return all;
    const matching = (all.value as ThreadSummary[])
      .filter((t) => (a.projectId === undefined || t.projectId === a.projectId) && (a.archived || !t.archived))
      .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    const limit = a.limit ?? 50;
    const more = matching.length - limit;
    return { ok: true, value: matching.slice(0, limit), ...(more > 0 ? { incomplete: `${more} more thread(s) match; raise the limit to see them.` } : {}) };
  });
  tool(READ_THREAD, (get, a: { threadId: string }) => get('threads.get', { id: a.threadId }));
  tool(SEARCH_THREADS, (get, a: { query: string }) => get('threads.search', { query: a.query }));
  tool(SEARCH_MEMORY, (get, a: { query: string }) => get('memory.search', { query: a.query }));
  tool(LIST_GOALS, async (get, a: { threadId?: string }) => {
    if (a.threadId !== undefined) {
      const t = await get('threads.get', { id: a.threadId });
      if (!t.ok) return t;
      const thread = t.value as Thread;
      return { ok: true, value: { threadId: thread.summary.id, title: thread.summary.title, goal: thread.goal ?? null, run: thread.goalRun ?? null } };
    }
    const runs = await get('goals.runs', {});
    if (!runs.ok) return runs;
    const listed = [];
    let unread = 0;
    for (const run of runs.value as GoalRun[]) {
      const t = await get('threads.get', { id: run.threadId });
      if (!t.ok) {
        // Its thread could not be read: that is not a run without a goal, so it says so instead of null.
        unread++;
        listed.push({ ...run, notRead: `${t.reason}: ${t.detail}` });
        continue;
      }
      const thread = t.value as Thread;
      listed.push({ ...run, title: thread.summary.title, goal: thread.goal?.current?.text ?? null });
    }
    return { ok: true, value: { runs: listed }, ...(unread ? { incomplete: `${unread} run(s) whose thread could not be read carry notRead, with no title or goal.` } : {}) };
  });
  tool(LIST_SCHEDULES, async (get, a: { limit?: number }) => {
    const view = await get('schedules.get', {});
    if (!view.ok) return view;
    const { schedules, heartbeat, runs } = redactWakeGates(view.value as Result<'schedules.get'>);
    return { ok: true, value: { schedules, heartbeat, runs: runs.slice(0, a.limit ?? 20) } };
  });
  return server;
}
