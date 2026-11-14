// Measures the mail triage job on the sample mailbox's labelled fixture, against the same job done
// without Backbone, and scores both blind (the pass criteria are [J-triage](../../../acceptance/J-triage/job.md)).
//
//   node packages/platform/examples/measure-triage.ts job --out <dir> [--endpoint <url> --model <id>]
//       The job itself: a fresh data home, Pi, the sample mailbox, formation, one run. With no
//       endpoint, the scripted model (no network, no key): a check of the plumbing, not of judgement.
//   node packages/platform/examples/measure-triage.ts baseline --out <dir> --endpoint <url> --model <id>
//       The same model in a plain loop: one raw message at a time and the same task text. No
//       connector, no receipts, no brief. Checkpoints every request. --deadline-ms defaults to
//       90 minutes and cannot exceed that; expiry preserves partial output and exits nonzero.
//   node packages/platform/examples/measure-triage.ts export --out <dir>
//       The raw mailbox (one .eml per message) and the task, for a fresh agent; the labels withheld.
//   node packages/platform/examples/measure-triage.ts score --out <dir> <arm dir>...
//       Scores every arm against the labels under an anonymous id, and writes the judge's packet of
//       drafts (shuffled, arms hidden) beside a sealed key.
//   node packages/platform/examples/measure-triage.ts reveal --out <dir> --judgements <file>
//       After a judge who saw only the packet: drafts usable as is or with light edits, per arm.
//
// An endpoint is an OpenAI-compatible server on this computer (a local model): the platform's route
// policy accepts only the loopback for a keyless route.
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FakeMailbox, FIXTURE_DIR, readSeed, readTask } from '@backbone-next/connector-mail';
import { createHost, removeDataHome } from '../src/composition/host.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import type { MailMessage } from '../src/ports/mail.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { NOTE_FORMAT, parseNote, rfc822, taskText } from '../src/triage/note.ts';

interface Output {
  id: string;
  requester: { name: string; address: string } | null;
  category: string | null;
  urgency: string | null;
  label: string | null;
  move: string | null;
  suspicious: boolean | null;
  reply: string | null;
  /** Machine wall time for this request, when the arm handles one at a time. */
  ms: number | null;
  error?: string;
}
interface ArmFile {
  arm: { name: string; model: string; route: string; harness: string; started: string; ended: string; note?: string };
  items: Output[];
  /** Questions that block work, and notices besides the brief. */
  interruptions: number | null;
  /** Proposals and needs-you items the person reviews in the brief. */
  touches: number | null;
}
interface Truth {
  requester: { name: string; address: string };
  category: string;
  urgency: string;
  label: string;
  move: string;
  needsReply: boolean;
  suspicious: boolean;
  facts: string[];
  mustNot: string[];
  lang: string;
}

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = resolve(flag('out') ?? join(tmpdir(), `triage-measure-${Date.now()}`));
const write = (file: string, value: unknown) => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const seed = readSeed();
const task = readTask();
const labels = JSON.parse(readFileSync(join(FIXTURE_DIR, 'labels.json'), 'utf8')) as { messages: Record<string, Truth> };
const limit = Number(flag('limit') ?? seed.messages.length);
const messages = seed.messages.slice(0, limit);
const ms = (a?: string, b?: string) => (a && b ? Date.parse(b) - Date.parse(a) : null);

async function job() {
  const endpoint = flag('endpoint');
  const scripted = endpoint ? null : await startScriptedModel();
  process.env.BACKBONE_MODEL_ENDPOINT = endpoint ?? scripted!.url;
  process.env.BACKBONE_MODEL_ID = flag('model') ?? scripted!.model;
  const home = mkdtempSync(join(tmpdir(), 'backbone-measure-'));
  const mailbox = new FakeMailbox({ seed: { ...seed, messages } });
  // A throwaway home: its keys stay in plain text by this explicit choice, as in the platform's example.
  const host = createHost({ home, harness: 'harness-pi', keys: plaintextKeys(), mail: { connector: mailbox } });
  const started = new Date().toISOString();
  try {
    const connected = await host.call('triage.connect', {});
    if (!connected.ok) throw new Error(connected.detail);
    const offer = (await host.call('triage.get', {})).offer!;
    // The measurement signs as the person would in main's window; the capability is the same.
    const signed = await host.signCapability({ hash: offer.hash, presence: 'touch-id' });
    if (!signed.ok) throw new Error(signed.detail);
    await host.triage.whenIdle();
    const run = await host.triage.run('person');
    const view = await host.call('triage.get', {});
    const state = host.triage.stored;
    const items: Output[] = messages.map((m) => {
      const i = state.items[m.id];
      const n = i?.note;
      const draft = view.brief.requests.find((r) => r.id === m.id)?.draft;
      return {
        id: m.id,
        requester: n?.requester ?? null,
        category: n?.category ?? null,
        urgency: n?.urgency ?? null,
        label: n?.label ?? null,
        move: n?.move ?? null,
        suspicious: n?.suspicious ?? null,
        // What the person finds in the viewer: the draft the job wrote, or none.
        reply: draft?.outcome === 'DONE' ? (n?.reply ?? null) : null,
        ms: ms(i?.startedAt, i?.endedAt),
        ...(i?.noteError ? { error: i.noteError } : {}),
      };
    });
    const file: ArmFile = {
      arm: { name: 'job', model: process.env.BACKBONE_MODEL_ID!, route: endpoint ? `endpoint ${endpoint}` : 'scripted model (loopback)', harness: 'Pi 1.4.0 behind the Harness port', started, ended: new Date().toISOString(), note: `run ${run.outcome}${run.reason ? `: ${run.reason}` : ''}; ${view.brief.counts.drafted} drafted, ${view.brief.counts.proposed} proposed, ${view.brief.counts.needsYou} need you` },
      items,
      // The job sends no notice, and proposals and needs-you items wait in the brief. A question the
      // core opened for anything but a proposal (work inside the capability) would interrupt.
      interruptions: [...(await host.triage.effects()).values()].filter((e) => e.decision_id && !['mail.label', 'mail.move'].includes(e.operation)).length,
      touches: view.brief.counts.proposed + view.brief.counts.needsYou,
    };
    write('outputs.json', file);
    console.log(`job: ${items.length} requests, ${file.arm.note}; written to ${join(out, 'outputs.json')}`);
  } finally {
    host.close();
    await removeDataHome(home);
    await scripted?.close();
  }
}

/** One raw message, the same task, the same model: no connector, no receipts, no brief. */
async function baseline() {
  const endpoint = flag('endpoint');
  const model = flag('model');
  if (!endpoint || !model) throw new Error('baseline needs --endpoint and --model (the same as the job arm).');
  const started = new Date().toISOString();
  const deadlineMs = Number(flag('deadline-ms') ?? 90 * 60_000);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 90 * 60_000) throw new Error('baseline --deadline-ms must be a positive integer no greater than 5400000.');
  const deadline = Date.now() + deadlineMs;
  const items: Output[] = [];
  const checkpoint = (note: string) => {
    write('outputs.next.json', {
      arm: { name: 'baseline', model, route: `endpoint ${endpoint}`, harness: 'a plain loop: one raw message per request, no tools', started, ended: new Date().toISOString(), note },
      items, interruptions: null, touches: null,
    } satisfies ArmFile);
    // A process kill during a checkpoint must leave the previous complete checkpoint readable.
    renameSync(join(out, 'outputs.next.json'), join(out, 'outputs.json'));
  };
  checkpoint(`in progress: 0/${messages.length} requests`);
  for (const m of messages) {
    if (Date.now() >= deadline) {
      checkpoint(`deadline exceeded: ${items.length}/${messages.length} requests; partial output`);
      process.exitCode = 1;
      return;
    }
    const message: MailMessage = { ...m, version: '1' };
    const prompt = `${taskText(task, seed.labels, seed.now)}\n\nThe email:\n\n${rfc822(message)}\n\nAnswer with exactly these lines:\n${NOTE_FORMAT}`;
    const t0 = Date.now();
    let text = '';
    let error: string | undefined;
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    try {
      const r = await fetch(`${endpoint.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer none' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
        signal,
      });
      const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      text = body.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      error = signal.aborted ? 'benchmark deadline exceeded' : String(e);
    }
    const parsed = parseNote(text, task, seed.labels);
    const n = parsed.ok ? parsed.note : null;
    items.push({ id: m.id, requester: n?.requester ?? null, category: n?.category ?? null, urgency: n?.urgency ?? null, label: n?.label ?? null, move: n?.move ?? null, suspicious: n?.suspicious ?? null, reply: n?.reply ?? null, ms: Date.now() - t0, ...(parsed.ok ? {} : { error: error ?? parsed.reason }) });
    checkpoint(signal.aborted ? `deadline exceeded: ${items.length}/${messages.length} requests; partial output` : `in progress: ${items.length}/${messages.length} requests`);
    if (signal.aborted) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write('.');
  }
  checkpoint(`complete: ${items.length}/${messages.length} requests`);
  console.log(`\nbaseline: ${items.length} requests; written to ${join(out, 'outputs.json')}`);
}

/** The raw mailbox for a fresh agent: one .eml per message and the task, the labels withheld. */
function exportMailbox() {
  mkdirSync(join(out, 'mailbox'), { recursive: true });
  for (const m of messages) writeFileSync(join(out, 'mailbox', `${m.id}.eml`), rfc822({ ...m, version: '1' }));
  write(
    'TASK.md',
    `# Triage this mailbox\n\nThe folder \`mailbox/\` holds ${messages.length} emails, one per file. For each one, write \`out/<id>.json\` (the file name without .eml) with exactly these fields:\n\n\`\`\`json\n{ "requester": { "name": "", "address": "" }, "category": "", "urgency": "", "label": "", "move": "", "suspicious": false, "reply": null }\n\`\`\`\n\n- \`label\` is the label's name or "none"; \`move\` is none, Archive or Spam; \`reply\` is the reply's text, or null when none is needed.\n\n${taskText(task, seed.labels, seed.now)}\n`,
  );
  console.log(`exported ${messages.length} messages and TASK.md to ${out}`);
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const ORDER = ['low', 'normal', 'high', 'urgent'];

function readArm(dir: string): ArmFile {
  const file = join(dir, 'outputs.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ArmFile;
  // A fresh agent's folder of out/<id>.json files.
  const folder = existsSync(join(dir, 'out')) ? join(dir, 'out') : dir;
  const meta = existsSync(join(dir, 'arm.json')) ? JSON.parse(readFileSync(join(dir, 'arm.json'), 'utf8')) : { name: 'agent', model: 'unknown', route: 'unknown', harness: 'a fresh agent with the raw mailbox', started: '', ended: '' };
  const items = messages.map((m): Output => {
    const f = join(folder, `${m.id}.json`);
    if (!existsSync(f)) return { id: m.id, requester: null, category: null, urgency: null, label: null, move: null, suspicious: null, reply: null, ms: null, error: 'no output' };
    const o = JSON.parse(readFileSync(f, 'utf8')) as Partial<Output>;
    return { id: m.id, requester: o.requester ?? null, category: o.category ?? null, urgency: o.urgency ?? null, label: o.label ?? null, move: o.move ?? null, suspicious: o.suspicious ?? null, reply: o.reply ?? null, ms: null };
  });
  return { arm: meta, items, interruptions: null, touches: null };
}

function scoreArm(a: ArmFile) {
  let requester = 0, category = 0, urgency = 0, urgencyNear = 0, all = 0, label = 0, move = 0, replyDecision = 0, suspicious = 0, suspiciousFound = 0, suspiciousFlagged = 0;
  const wrong: string[] = [];
  for (const o of a.items) {
    const t = labels.messages[o.id];
    const r = !!o.requester && (norm(o.requester.address) === norm(t.requester.address) || (!t.requester.address && norm(o.requester.name) === norm(t.requester.name)));
    const c = norm(o.category) === t.category;
    const u = norm(o.urgency) === t.urgency;
    if (r) requester++;
    if (c) category++;
    if (u) urgency++;
    if (o.urgency && Math.abs(ORDER.indexOf(norm(o.urgency)) - ORDER.indexOf(t.urgency)) <= 1) urgencyNear++;
    if (r && c && u) all++;
    else wrong.push(`${o.id}: ${[!r && `requester ${o.requester?.address ?? '-'}≠${t.requester.address}`, !c && `category ${o.category}≠${t.category}`, !u && `urgency ${o.urgency}≠${t.urgency}`].filter(Boolean).join(', ')}`);
    if (norm(o.label ?? 'none') === norm(t.label)) label++;
    if (norm(o.move ?? 'none') === norm(t.move)) move++;
    if (!!o.reply === t.needsReply) replyDecision++;
    if (t.suspicious) {
      suspicious++;
      if (o.suspicious) suspiciousFound++;
    }
    if (o.suspicious) suspiciousFlagged++;
  }
  const n = a.items.length;
  const pct = (x: number, of = n) => Math.round((1000 * x) / Math.max(1, of)) / 10;
  const times = a.items.map((o) => o.ms).filter((x): x is number => x !== null).sort((x, y) => x - y);
  const wall = Date.parse(a.arm.ended) - Date.parse(a.arm.started);
  return {
    n,
    requester: pct(requester),
    category: pct(category),
    urgency: pct(urgency),
    urgencyWithinOneLevel: pct(urgencyNear),
    allThree: pct(all),
    label: pct(label),
    move: pct(move),
    replyDecision: pct(replyDecision),
    suspiciousRecall: pct(suspiciousFound, suspicious),
    suspiciousFlagged,
    msPerRequestMedian: times.length ? times[Math.floor(times.length / 2)] : null,
    msPerRequestP90: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.9))] : null,
    msPerRequestFromWall: Number.isFinite(wall) ? Math.round(wall / n) : null,
    interruptions: a.interruptions,
    touches: a.touches,
    errors: a.items.filter((o) => o.error).length,
    wrong,
  };
}

function score(dirs: string[]) {
  const arms = dirs.map(readArm);
  // Anonymous ids, shuffled: the judge never sees which arm wrote which draft.
  const ids = arms.map((_, i) => `arm-${String.fromCharCode(65 + i)}`).sort(() => randomInt(3) - 1);
  const key = Object.fromEntries(arms.map((a, i) => [ids[i], { name: a.arm.name, model: a.arm.model, route: a.arm.route, dir: dirs[i] }]));
  const scores = Object.fromEntries(arms.map((a, i) => [ids[i], scoreArm(a)]));
  const packet: { item: string; message: string; facts: string[]; mustNot: string[]; draft: string | null }[] = [];
  const sealed: Record<string, { arm: string; message: string }> = {};
  for (const m of messages) {
    const t = labels.messages[m.id];
    if (!t.needsReply) continue;
    arms.forEach((a, i) => {
      const item = randomUUID().slice(0, 8);
      packet.push({ item, message: rfc822({ ...m, version: '1' }), facts: t.facts, mustNot: t.mustNot, draft: a.items.find((o) => o.id === m.id)?.reply ?? null });
      sealed[item] = { arm: ids[i], message: m.id };
    });
  }
  packet.sort(() => randomInt(3) - 1);
  write('scores.json', scores);
  write('judge-packet.json', {
    rubric: 'For each item, judge the draft as a reply Marta would send to the email shown. as-is: send it unchanged. light: at most two sentence-level changes and no factual fix. heavy: more than that, or a factual fix. unusable: wrong recipient, wrong language, or misses the point. critical: it promises money, a date, a price or a decision the email does not support, discloses another email\'s content, or does something listed under mustNot. A missing draft (null) is unusable. Write judgements.json: [{ "item": "...", "verdict": "as-is|light|heavy|unusable|critical", "why": "one line" }].',
    items: packet,
  });
  write('sealed-key.json', { arms: key, items: sealed });
  for (const [id, s] of Object.entries(scores)) {
    console.log(`${id}: requester ${s.requester}%, category ${s.category}%, urgency ${s.urgency}% (±1 level ${s.urgencyWithinOneLevel}%), all three ${s.allThree}%, label ${s.label}%, move ${s.move}%, reply decision ${s.replyDecision}%, suspicious recall ${s.suspiciousRecall}%, ms/request median ${s.msPerRequestMedian ?? '-'} (wall ${s.msPerRequestFromWall ?? '-'})`);
  }
  console.log(`judge packet: ${packet.length} drafts; scores, packet and sealed key in ${out}`);
}

function reveal() {
  const judgements = JSON.parse(readFileSync(resolve(flag('judgements')!), 'utf8')) as { item: string; verdict: string }[];
  const sealed = JSON.parse(readFileSync(join(out, 'sealed-key.json'), 'utf8')) as { arms: Record<string, { name: string; model: string }>; items: Record<string, { arm: string; message: string }> };
  const per: Record<string, Record<string, number>> = {};
  for (const j of judgements) {
    const s = sealed.items[j.item];
    if (!s) continue;
    per[s.arm] ??= {};
    per[s.arm][j.verdict] = (per[s.arm][j.verdict] ?? 0) + 1;
  }
  const result = Object.fromEntries(Object.entries(per).map(([arm, v]) => {
    const total = Object.values(v).reduce((a, b) => a + b, 0);
    return [arm, { ...sealed.arms[arm], verdicts: v, usable: Math.round((1000 * ((v['as-is'] ?? 0) + (v.light ?? 0))) / Math.max(1, total)) / 10, critical: v.critical ?? 0, judged: total }];
  }));
  write('drafts.json', result);
  for (const [arm, r] of Object.entries(result)) console.log(`${arm} (${r.name}, ${r.model}): usable as is or with light edits ${r.usable}% of ${r.judged}; critical ${r.critical}`);
}

if (command === 'job') await job();
else if (command === 'baseline') await baseline();
else if (command === 'export') exportMailbox();
else if (command === 'score') score(argv.slice(1).filter((x, i, all) => !x.startsWith('--') && !(all[i - 1] ?? '').startsWith('--')));
else if (command === 'reveal') reveal();
else {
  console.error('usage: measure-triage.ts job|baseline|export|score|reveal --out <dir> [...]');
  process.exit(2);
}
