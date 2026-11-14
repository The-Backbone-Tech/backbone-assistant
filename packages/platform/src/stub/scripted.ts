// A scripted stand-in for the Harness port, for acceptance journeys: no model is called. Each
// message's plan (what to read, the one write, what to answer, and an optional hold before the
// write) is handed in as a file of the script folder, named by the message's hash; the agent
// records there everything it was given (seen.jsonl), so a journey judges what the agent saw.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { EffectRecord, FileLink, MaterialEntry, Turn } from '../api.ts';
import { bindRead, type HarnessContext } from './harness.ts';

export const SCRIPTED_LABEL = 'Scripted stand-in harness (no model called)';

interface Plan {
  read?: string[];
  write?: { title: string; content: string; document?: string; version?: number };
  hold?: string;
  answer: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const link = (e: MaterialEntry): FileLink => ({ materialId: e.id, name: e.name, version: e.current });

/** The text cells of an Office Open XML workbook: inline strings and values, in sheet order. */
export function workbookText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const parts: string[] = [];
  for (let at = 0; at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50; ) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLength = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    const data = buf.subarray(start, start + size);
    if (name.startsWith('xl/worksheets/') || name === 'xl/sharedStrings.xml') {
      const xml = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
      for (const m of xml.matchAll(/<(?:t|v)[^>]*>([^<]*)<\/(?:t|v)>/g)) parts.push(m[1]);
    }
    at = start + size;
  }
  return parts.join(' ');
}

async function planFor(dir: string, text: string, signal: AbortSignal): Promise<Plan> {
  const path = join(dir, 'plans', `${sha(text)}.json`);
  for (let i = 0; i < 100 && !existsSync(path) && !signal.aborted; i++) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(path)) return { answer: 'There was no plan for this message.' };
  return JSON.parse(readFileSync(path, 'utf8')) as Plan;
}

async function holdAt(dir: string, id: string, signal: AbortSignal): Promise<boolean> {
  writeFileSync(join(dir, 'held', id), '');
  while (!existsSync(join(dir, 'release', id))) {
    if (signal.aborted) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !signal.aborted;
}

/** Runs one scripted turn, mutating `turn` as it goes. Its reads and its write go through the gateway. */
export async function runScriptedTurn(ctx: HarnessContext, dir: string, turn: Turn): Promise<void> {
  const plan = await planFor(dir, turn.user.text, ctx.signal);
  // Every read is bound as it happens, so a turn that reads nothing has an empty read set, not an unknown one.
  turn.reads ??= [];
  const all = ctx.material.available(ctx.projectId);
  const documents: { id: string; version: number; content: string }[] = [];
  for (const title of plan.read ?? []) {
    const e = all.find((x) => x.name === title);
    if (!e) continue;
    turn.work.steps.push({ kind: 'read', label: `Read ${e.name} v${e.current}` });
    await bindRead(ctx, turn, e);
    const prepared = await ctx.gateway.read({ materialId: e.id, name: e.name, version: e.current, withdrawals: e.withdrawals?.length ?? 0, profile: 'scripted' });
    documents.push({ id: prepared.materialId, version: prepared.version, content: prepared.text });
  }
  appendFileSync(join(dir, 'seen.jsonl'), `${JSON.stringify({ text: [turn.user.text, ...documents.map((d) => d.content)].join('\n'), documents })}\n`);

  if (plan.write) {
    const w = plan.write;
    if (plan.hold && !(await holdAt(dir, plan.hold, ctx.signal))) {
      turn.answer = { text: 'Stopped before the write was handed over; nothing was sent.', files: [] };
      turn.status = 'stopped';
      return;
    }
    if (ctx.signal.aborted) {
      turn.answer = { text: 'Stopped before the write was handed over; nothing was sent.', files: [] };
      turn.status = 'stopped';
      return;
    }
    const existing = w.document ? all.find((x) => x.id === w.document) : all.find((x) => x.name === w.title);
    const document = existing?.id ?? createHash('sha256').update(`${ctx.projectId}\0${w.title}`).digest('hex').replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, '$1-$2-4$3-8$4-$5');
    const effect: EffectRecord = { key: '', kind: 'write-working-copy', target: w.title, outcome: 'UNKNOWN' };
    turn.effects.push(effect);
    const entry = await ctx.gateway.write({ name: w.title, document, body: w.content, baseVersion: existing?.current ?? null }, effect, async () => {
      if (ctx.signal.aborted) return 'stopped';
      if (existing) {
        const r = await ctx.material.save(existing.id, w.content, w.version ?? existing.current, 'agent');
        if (!r.ok) throw new Error(r.detail);
        return r.value;
      }
      return ctx.material.create(ctx.projectId, w.title, 'text/markdown', Buffer.from(w.content), 'working', 'agent', document);
    });
    if (!entry) {
      turn.answer = { text: effect.detail ?? 'The write did not go through.', files: [] };
      turn.status = effect.outcome === 'UNKNOWN' ? 'stopped' : 'done';
      return;
    }
    turn.answer = { text: plan.answer, files: [link(entry)] };
    turn.status = 'done';
    return;
  }
  turn.answer = { text: plan.answer, files: [] };
  turn.status = 'done';
}
