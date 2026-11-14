// A deterministic stand-in for the Harness port: no model is called. It reads the attached and
// current material, writes a working-copy brief when asked to, and answers follow-ups from the
// versions that are current. Its reads and its write go through the core (the `gateway`): the
// core records what it read and decides, dispatches and observes its write. A real harness (Pi
// behind HarnessV1) replaces this agent next; the gateway stays.
import type { EffectRecord, FileLink, MaterialEntry, Turn, WorkStep } from '../api.ts';
import type { ConnectorCore } from '../connectors/service.ts';
import { SIDE_CHAT_TOOLS } from '../api.ts';
import { createHash } from 'node:crypto';
import type { MaterialStore } from './material.ts';
import type { MaterialFileReadRequest, MaterialFileReadResult } from '../composition/material-file-read.ts';

export const HARNESS_LABEL = 'Stub harness (no model called)';
const WRITE_INTENT = /\b(write|draft|create|make|produce|prepare)\b[^.?!]*\b(brief|document|summary)\b/i;
const EFFECT_INTENT = /\b(change|edit|write|delete|remove|modify|update|rename|save|create|run|commit|send|move|fix)\b/i;


/** The core's side of a turn: what the agent read, and its one write through the effect gateway. */
export interface Gateway {
  readonly conditionalWrites?: true;
  read(request: MaterialFileReadRequest): Promise<MaterialFileReadResult>;
  /** The core's side of a connector call: its read recorded as an `mcp` source, or its effect held for a person. */
  connector?: ConnectorCore;
  /**
   * Propose the write; when the gateway lets it through, claim and dispatch it, calling `perform`
   * to do it. A write stopped once dispatch began is UNKNOWN; an exact copy of one is refused.
   * `effect` is already on the turn (UNKNOWN until settled); the gateway fills in what came of it.
   */
  write(
    target: { name: string; document: string; body: string; baseVersion: number | null; sourceVersions?: { id: string; name: string; version: number }[]; managed?: true; held?: { id: string; name: string; changed?: boolean } },
    effect: EffectRecord,
    perform: () => Promise<MaterialEntry | 'stopped'>,
  ): Promise<MaterialEntry | undefined>;
}

export interface HarnessContext {
  material: MaterialStore;
  projectId: string;
  gateway: Gateway;
  writeDelayMs: number;
  signal: AbortSignal;
  /** Saves the turn, so a read is on disk before its text is handed over and a kill cannot lose it. */
  progress?: () => void | Promise<void>;
}

/**
 * Binds a read to its turn and saves it before the text is handed over, as the real harnesses do. A save
 * that fails throws, so the text is not handed over: the journal records the turn only at its end, and a
 * kill before then would lose that the turn had it.
 */
export async function bindRead(ctx: Pick<HarnessContext, 'progress'>, turn: Turn, e: MaterialEntry): Promise<void> {
  (turn.reads ??= []).push({ id: e.id, name: e.name, version: e.current, withdrawals: e.withdrawals?.length ?? 0 });
  await ctx.progress?.();
}

/** A UUID-shaped identity derived from `seed`. */
function uuidOf(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const link = (e: MaterialEntry): FileLink => ({ materialId: e.id, name: e.name, version: e.current });

// Like Pi and Hermes: a version is described by its class, never by an inferred author.
const owner = (e: MaterialEntry) => (e.class === 'original' ? 'original source' : 'recorded version');

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve(false)), { once: true });
  });
}

/** Runs one main-thread turn to completion, mutating `turn` as it goes. */
export async function runTurn(ctx: HarnessContext, turn: Turn, attachments: MaterialEntry[]): Promise<void> {
  const steps: WorkStep[] = turn.work.steps;
  // Every read is bound as it happens, so a turn that reads nothing has an empty read set, not an unknown one.
  turn.reads ??= [];
  const all = ctx.material.list(ctx.projectId);
  const sources = attachments.length ? attachments : all;
  const preparations = new Map<string, MaterialFileReadResult>();
  const read = async (e: MaterialEntry) => {
    if (preparations.has(e.id)) return preparations.get(e.id)!;
    steps.push({ kind: 'read', label: `Read ${e.name} v${e.current}` });
    await bindRead(ctx, turn, e);
    const prepared = await ctx.gateway.read({ materialId: e.id, name: e.name, version: e.current, withdrawals: e.withdrawals?.length ?? 0, profile: 'stub' });
    preparations.set(e.id, prepared);
    return prepared;
  };
  for (const e of sources) await read(e);

  if (!WRITE_INTENT.test(turn.user.text)) {
    const docs = all.filter((e) => e.class !== 'original');
    for (const e of docs) await read(e);
    const lines = docs.map((e) => `- ${e.name} v${e.current} (${owner(e)}). It says: ${preparations.get(e.id)!.text.split(': ').slice(1).join(': ')}`);
    turn.answer = {
      text: docs.length ? `I read the current versions:\n${lines.join('\n')}` : `I read ${sources.length} file(s). Nothing has been drafted in this project yet.`,
      files: docs.map(link),
    };
    turn.status = 'done';
    return;
  }

  const existing = all.find((e) => e.name === 'brief.md');
  const body = [
    '# Brief',
    '',
    `Request: ${turn.user.text}`,
    '',
    '## Sources',
    ...attachments.map((e) => `- ${preparations.get(e.id)!.text}`),
    ...(attachments.length ? [] : ['- (no attachments)']),
    '',
    '## Draft',
    '',
    'Edit this document, then Save to make it yours.',
    '',
  ].join('\n');
  steps.push({ kind: 'write', label: 'Write brief.md' });
  // A new brief's identity follows from its project and name, so the same write is the same change.
  const document = existing?.id ?? uuidOf(`${ctx.projectId}\0brief.md`);
  const effect: EffectRecord = { key: '', kind: 'write-working-copy', target: 'brief.md', outcome: 'UNKNOWN' };
  turn.effects.push(effect);
  const entry = await ctx.gateway.write({ name: 'brief.md', document, body, baseVersion: existing?.current ?? null }, effect, async () => {
    if (!(await sleep(ctx.writeDelayMs, ctx.signal))) return 'stopped';
    if (existing) {
      const r = await ctx.material.save(existing.id, body, existing.current, 'agent');
      if (!r.ok) throw new Error(r.detail);
      return r.value;
    }
    return ctx.material.create(ctx.projectId, 'brief.md', 'text/markdown', Buffer.from(body), 'working', 'agent', document);
  });
  if (!entry) {
    turn.answer = { text: effect.detail ?? 'The write did not go through.', files: existing && effect.outcome === 'REFUSED' ? [link(existing)] : [] };
    turn.status = effect.outcome === 'UNKNOWN' || ctx.signal.aborted ? 'stopped' : 'done';
    return;
  }
  turn.answer = { text: `I drafted brief.md v${entry.current} from ${attachments.length} source(s). It is open beside the conversation for you to edit.`, files: [link(entry)] };
  turn.status = 'done';
}

/** The side chat: read, search and list only. Anything asking for an effect is refused by name. */
export function runSideTurn(material: MaterialStore, projectId: string, turn: Turn): void {
  if (EFFECT_INTENT.test(turn.user.text)) {
    turn.refusal = {
      reason: 'SIDE_CHAT_READ_ONLY',
      detail: `Side chats can only ${SIDE_CHAT_TOOLS.join(', ')}; they cannot change anything. Ask in the main thread to make this change.`,
    };
    turn.status = 'refused';
    return;
  }
  const all = material.list(projectId);
  turn.work.steps.push({ kind: 'list', label: `Listed ${all.length} file(s)` });
  turn.answer = {
    text: all.length ? all.map((e) => `- ${e.name} v${e.current} (${e.class})`).join('\n') : 'This project has no files yet.',
    files: all.map(link),
  };
  turn.status = 'done';
}
