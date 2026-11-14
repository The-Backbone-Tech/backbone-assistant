// Talking to running work, and bringing a worker's documents back: messages that wait, words that
// reach a turn only when the engine says so, and a merge that never replaces anyone's version.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { METHODS, type Thread, type Turn } from '../src/api.ts';
import { hostClosed } from '../src/composition/host.ts';
import type { HarnessV1 } from '../src/ports/harness.ts';
import { scriptedStep, startScriptedModel, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { pollUntil, b64, freshHome, idle, open, settings, value  } from './helpers.ts';

const text = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keeps "Hold on" turns listing files until the test lets go, so a turn stays open to be steered. */
let holding = false;
function stepped(messages: Message[]): Step {
  const asked = messages.findLastIndex((m) => m.role === 'user');
  if (/Write the source note/.test(text(messages[asked]))) {
    return messages.slice(asked + 1).some(m => m.role === 'tool') ? { text: 'Wrote the source note.' }
      : { calls: [{ name: 'write_file', args: { name: 'note.md', content: 'source' } }] };
  }
  if (/Read the note/.test(text(messages[asked]))) {
    const called = messages.slice(asked + 1).flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
    if (!called.includes('read_file')) return { calls: [{ name: 'read_file', args: { name: 'note.md' } }] };
    if (/without writing/.test(text(messages[asked]))) return { text: 'Read the note.' };
    if (!called.includes('write_file')) return { calls: [{ name: 'write_file', args: { name: 'brief.md', content: 'From the note.' } }] };
    return { text: 'Wrote it.' };
  }
  const start = messages.findIndex((m) => m.role === 'user' && /Hold on/.test(text(m)));
  if (start < 0) return scriptedStep(messages);
  const after = messages.slice(start + 1);
  if (holding) return { calls: [{ name: 'list_files', args: {} }] };
  const words = after.filter((m) => m.role === 'user').map(text);
  return { text: `Saw: ${words.join(' | ') || 'nothing'}` };
}

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel('scripted-model', stepped);
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

/** Counts writes that reached dispatch: Stop before that is a clean cancel, correctly REFUSED, not an UNKNOWN. */
function inWrite() {
  const seen = { writes: 0 };
  return { seen, atPoint: (point: string) => { if (point === 'write.begun') seen.writes++; } };
}

async function thread(options: Parameters<typeof open>[1] = {}, home = freshHome()) {
  const ctx = open(home, options);
  const p = value(await ctx.host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await ctx.host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'first' }));
  await idle(ctx.host, sent.threadId);
  return { ...ctx, p, threadId: sent.threadId };
}
type Hosted = Awaited<ReturnType<typeof thread>>;
const get = async (s: Pick<Hosted, 'host'>, id: string) => value(await s.host.call('threads.get', { id }));
const queued = (s: Hosted, words: string, clientKey = words) => s.host.call('queue.add', { threadId: s.threadId, text: words, attachments: [], settings, clientKey });
/** A turn held open: the stub writes slowly when given a delay. */
const slow = (s: Hosted, words = 'Write an editable brief') => s.host.call('turns.send', { projectId: s.p.id, threadId: s.threadId, text: words, attachments: [], settings, clientKey: words });
/** A Pi turn listing files until `holding` ends: open for as long as the test needs, holding no lock. */
async function held(s: Hosted) {
  holding = true;
  value(await s.host.call('turns.send', { projectId: s.p.id, threadId: s.threadId, text: 'Hold on, then answer', attachments: [], settings, clientKey: `h${Math.random()}` }));
  await until(() => get(s, s.threadId), (x) => x.turns.at(-1)?.work.steps.some((w) => w.kind === 'list') === true, 'turn in its tool call');
}
const sendNow = (s: Pick<Hosted, 'host' | 'threadId'>, m: { id: string; version: number }) => s.host.call('queue.send', { threadId: s.threadId, id: m.id, baseVersion: m.version });
const until = async <T>(read: () => Promise<T>, pass: (v: T) => boolean, label = 'condition') => {
  return await pollUntil(async active => {
    while (active()) { const v = await read(); if (pass(v)) return v; await wait(10); }
    throw new Error(`never: ${label}`);
  }, "packages/platform/test/steer-and-merge.test.ts state polling");
};
const lastUser = (t: Thread) => t.turns.map((x: Turn) => x.user.text);

test('the new methods are additive on the api port', () => {
  for (const m of ['turns.steer', 'queue.add', 'queue.edit', 'queue.remove', 'queue.send', 'children.merge'] as const) assert.ok(METHODS.includes(m), m);
});

test('a message waits for the running turn, in order, and each is sent once', async () => {
  const s = await thread({ harness: 'harness-pi' });
  await held(s);
  const a = value(await queued(s, 'First after'));
  value(await queued(s, 'Second after'));
  const again = value(await queued(s, 'First after'));
  assert.equal(again.id, a.id, 'the same key is the same message');
  const during = await get(s, s.threadId);
  assert.deepEqual(during.queue?.map((m) => m.text), ['First after', 'Second after']);
  assert.equal(during.queueHeld, undefined, 'it waits for the turn, not for the person');
  holding = false;
  const t = await until(() => get(s, s.threadId), (x) => x.turns.length === 4 && !x.summary.running, 'both sent');
  assert.deepEqual(lastUser(t), ['Hello', 'Hold on, then answer', 'First after', 'Second after']);
  assert.deepEqual(t.queue ?? [], []);
  const after = await queued(s, 'First after');
  assert.equal(after.ok, false, 'a retried add does not send it twice');
  await wait(50);
  assert.equal((await get(s, s.threadId)).turns.length, 4);
});

test('an idle thread sends a queued message at once', async () => {
  const s = await thread();
  value(await queued(s, 'Right away'));
  const t = await until(() => get(s, s.threadId), (x) => x.turns.length === 2 && !x.summary.running, 'sent');
  assert.equal(t.turns[1].user.text, 'Right away');
});

test('a queued message is edited and removed on the view the person saw, and never after it was sent', async () => {
  const s = await thread({ harness: 'harness-pi' });
  await held(s);
  const a = value(await queued(s, 'Keep me'));
  const b = value(await queued(s, 'Drop me'));
  const edited = value(await s.host.call('queue.edit', { threadId: s.threadId, id: a.id, text: 'Kept, changed', baseVersion: a.version }));
  assert.equal(edited.version, a.version + 1);
  const stale = await s.host.call('queue.edit', { threadId: s.threadId, id: a.id, text: 'Late', baseVersion: a.version });
  assert.deepEqual([stale.ok, !stale.ok && stale.reason], [false, 'STALE_BASE']);
  const empty = await s.host.call('queue.edit', { threadId: s.threadId, id: a.id, text: '   ', baseVersion: edited.version });
  assert.deepEqual([empty.ok, !empty.ok && empty.reason], [false, 'INVALID']);
  value(await s.host.call('queue.remove', { threadId: s.threadId, id: b.id, baseVersion: b.version }));
  holding = false;
  const t = await until(() => get(s, s.threadId), (x) => x.turns.length === 3 && !x.summary.running, 'sent');
  assert.equal(t.turns[2].user.text, 'Kept, changed');
  const late = await s.host.call('queue.edit', { threadId: s.threadId, id: a.id, text: 'Too late', baseVersion: edited.version });
  assert.deepEqual([late.ok, !late.ok && late.reason], [false, 'STALE_BASE']);
  assert.match(!late.ok ? late.detail : '', /already sent|removed/);
  const gone = await s.host.call('queue.remove', { threadId: s.threadId, id: a.id, baseVersion: edited.version });
  assert.equal(gone.ok, false);
});

test('Stop holds the queue: nothing is sent until the person says so', async () => {
  const s = await thread({ writeDelayMs: 500 });
  value(await slow(s));
  value(await queued(s, 'Wait for me'));
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running, 'stopped');
  await wait(100);
  const still = await get(s, s.threadId);
  assert.equal(still.turns.length, t.turns.length);
  assert.deepEqual(still.queue?.map((m) => m.text), ['Wait for me']);
  assert.match(still.queueHeld ?? '', /stopped/i);
  const head = still.queue![0];
  const first = value(await sendNow(s, head));
  const sent = await until(() => get(s, s.threadId), (x) => x.turns.at(-1)?.user.text === 'Wait for me' && !x.summary.running, 'sent');
  assert.equal(value(await sendNow(s, head)).turnId, first.turnId, 'a retry finds the turn it made');
  assert.deepEqual(sent.queue ?? [], []);
  assert.equal(sent.queueHeld, undefined);
});

test('an UNKNOWN holds the queue, and only the person sends past it', async () => {
  const { seen, atPoint } = inWrite();
  const s = await thread({ writeDelayMs: 1500, atPoint });
  const before = seen.writes;
  value(await slow(s));
  await until(async () => seen.writes, (n) => n > before, 'write under way');
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running, 'stopped');
  assert.equal(t.turns.at(-1)!.effects[0].outcome, 'UNKNOWN');
  const count = t.turns.length;
  value(await queued(s, 'After the unknown'));
  await wait(100);
  const still = await get(s, s.threadId);
  assert.equal(still.turns.length, count, 'it does not go by itself');
  assert.deepEqual(still.queue?.map((m) => m.text), ['After the unknown']);
  assert.match(still.queueHeld ?? '', /UNKNOWN/);
  value(await sendNow(s, still.queue![0]));
  const sent = await until(() => get(s, s.threadId), (x) => x.turns.length === count + 1 && !x.summary.running, 'the person sent it');
  assert.equal(sent.turns.at(-2)!.effects[0].outcome, 'UNKNOWN', 'and nothing was settled by that');
});

test('a message waiting when the turn stopped is held across a restart: resuming starts nothing', async () => {
  const { seen, atPoint } = inWrite();
  const s = await thread({ writeDelayMs: 1500, atPoint });
  const before = seen.writes;
  value(await slow(s));
  await until(async () => seen.writes, (n) => n > before, 'write under way');
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  await until(() => get(s, s.threadId), (x) => !x.summary.running, 'stopped');
  value(await queued(s, 'Not after a restart'));
  const count = (await get(s, s.threadId)).turns.length;
  s.host.close();
  await hostClosed(s.home);
  const again = open(s.home);
  await again.host.resumeInterrupted();
  await wait(150);
  const t = value(await again.host.call('threads.get', { id: s.threadId }));
  assert.equal(t.turns.length, count);
  assert.deepEqual(t.queue?.map((m) => m.text), ['Not after a restart']);
  assert.ok(t.queueHeld);
});

test('a parent\'s Stop holds its children\'s queues, past a child\'s later clean turn', async () => {
  const s = await thread({ harness: 'harness-pi' });
  holding = true;
  const kid = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Hold on, then answer', role: 'worker', clientKey: 'k' }));
  await until(() => get(s, kid.threadId), (x) => x.turns.at(-1)?.work.steps.some((w) => w.kind === 'list') === true, 'child in its tool call');
  value(await s.host.call('queue.add', { threadId: kid.threadId, text: 'Waiting in the child', attachments: [], settings, clientKey: 'q' }));
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  holding = false;
  await until(() => get(s, kid.threadId), (x) => !x.summary.running, 'child stopped');
  value(await s.host.call('turns.send', { projectId: s.p.id, threadId: kid.threadId, text: 'Hello again', attachments: [], settings, clientKey: 'clean' }));
  await idle(s.host, kid.threadId);
  await wait(100);
  const t = await get(s, kid.threadId);
  assert.equal(t.turns.at(-1)!.user.text, 'Hello again');
  assert.deepEqual(t.queue?.map((m) => m.text), ['Waiting in the child'], 'a clean turn does not lift a Stop');
  assert.match(t.queueHeld ?? '', /stopped/i);
});

test('Stop reaches a send still being admitted', async () => {
  const s = await thread();
  const count = (await get(s, s.threadId)).turns.length;
  const sending = s.host.call('turns.send', { projectId: s.p.id, threadId: s.threadId, text: 'Hello once more', attachments: [], settings, clientKey: 'raced' });
  const stopping = s.host.call('turns.stop', { threadId: s.threadId });
  const [sent] = await Promise.all([sending, stopping]);
  assert.equal(sent.ok, false, 'nothing started after the Stop');
  assert.equal((await get(s, s.threadId)).turns.length, count);
});

test('a retry of a first message with its lost answer finds the chat it made', async () => {
  const s = await thread();
  const args = { projectId: s.p.id, text: 'A new chat', attachments: [], settings, clientKey: 'lost' };
  const first = value(await s.host.call('turns.send', args));
  await idle(s.host, first.threadId);
  const again = value(await s.host.call('turns.send', args));
  assert.deepEqual([again.threadId, again.turnId], [first.threadId, first.turnId]);
  assert.equal((await s.host.call('threads.list', {})).filter((t) => t.title === 'A new chat').length, 1);
});

test('a queued message survives a reopen, and is held by the turn the quit stopped', async () => {
  const s = await thread({ harness: 'harness-pi' });
  await held(s);
  const q = value(await queued(s, 'Across the quit'));
  s.host.close();
  await hostClosed(s.home);
  holding = false;
  const again = open(s.home, { harness: 'harness-pi' });
  const t = await until(() => again.host.call('threads.get', { id: s.threadId }).then(value), (x) => !x.summary.running, 'reopened');
  assert.deepEqual(t.queue?.map((m) => [m.id, m.text]), [[q.id, 'Across the quit']]);
  value(await again.host.call('queue.send', { threadId: s.threadId, id: q.id, baseVersion: q.version }));
  const sent = await until(() => again.host.call('threads.get', { id: s.threadId }).then(value), (x) => x.turns.at(-1)?.user.text === 'Across the quit' && !x.summary.running, 'sent');
  assert.equal(sent.turns.filter((x) => x.user.text === 'Across the quit').length, 1);
});

test('a message waiting at a reopen is sent when nothing holds it, by resuming, not by opening', async () => {
  const s = await thread();
  // Paused by a Stop with nothing running, then the pause lifted on the record: as a kill between a turn's end and its drain leaves it.
  value(await queued(s, 'Sent already'));
  await until(() => get(s, s.threadId), (x) => x.turns.length === 2 && !x.summary.running, 'sent');
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  const home = s.home;
  s.host.close();
  await hostClosed(home);
  const { ThreadJournal } = await import('../src/composition/thread-journal.ts');
  const journal = new ThreadJournal(home);
  journal.append({ kind: 'queue.added', threadId: s.threadId, message: { id: 'waiting', text: 'Left waiting', attachments: [], settings, version: 1, at: new Date().toISOString() } });
  const { createHost } = await import('../src/composition/host.ts');
  const host = createHost({ home });
  const opened = value(await host.call('threads.get', { id: s.threadId }));
  assert.deepEqual(opened.queue?.map((m) => m.text), ['Left waiting']);
  await wait(100);
  assert.equal(value(await host.call('threads.get', { id: s.threadId })).turns.length, 2, 'opening sends nothing');
  await host.resumeInterrupted();
  await until(() => host.call('threads.get', { id: s.threadId }).then(value), (x) => x.turns.length === 3 && !x.summary.running, 'sent on resume');
  host.close();
  await hostClosed(home);
});

test('a queued attachment withdrawn while it waited is not sent, and the message is not lost', async () => {
  const s = await thread({ writeDelayMs: 300 });
  const file = value(await s.host.call('material.attach', { projectId: s.p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  value(await slow(s));
  value(await s.host.call('queue.add', { threadId: s.threadId, text: 'Use the note', attachments: [file.id], settings, clientKey: 'n' }));
  value(await s.host.call('material.lifecycle', { id: file.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running && !!x.queue?.[0]?.problem, 'problem shown');
  assert.match(t.queue![0].problem!, /withdrawn/);
  assert.ok(!t.turns.some((x) => x.user.text === 'Use the note'));
});

test('a Send now that cannot start leaves Stop standing, and answers for one message only', async () => {
  const s = await thread({ harness: 'harness-pi' });
  const file = value(await s.host.call('material.attach', { projectId: s.p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  await held(s);
  value(await s.host.call('queue.add', { threadId: s.threadId, text: 'Use the note', attachments: [file.id], settings, clientKey: 'n' }));
  value(await queued(s, 'And then this'));
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  holding = false;
  await until(() => get(s, s.threadId), (x) => !x.summary.running, 'stopped');
  value(await s.host.call('material.lifecycle', { id: file.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  const before = (await get(s, s.threadId)).queue!;
  const refused = await sendNow(s, before[0]);
  assert.equal(refused.ok, false);
  const behind = await sendNow(s, before[1]);
  assert.deepEqual([behind.ok, !behind.ok && behind.reason], [false, 'STALE_BASE'], 'only the oldest can go');
  assert.match((await get(s, s.threadId)).queueHeld ?? '', /stopped/i, 'the hold stands');
  value(await s.host.call('turns.send', { projectId: s.p.id, threadId: s.threadId, text: 'A turn of mine', attachments: [], settings, clientKey: 'mine' }));
  await idle(s.host, s.threadId);
  await wait(100);
  const after = await get(s, s.threadId);
  assert.deepEqual(after.queue?.map((m) => m.text), ['Use the note', 'And then this'], 'a clean turn does not lift a Stop');
  const head = after.queue![0];
  value(await s.host.call('queue.remove', { threadId: s.threadId, id: head.id, baseVersion: head.version }));
  value(await sendNow(s, (await get(s, s.threadId)).queue![0]));
  await until(() => get(s, s.threadId), (x) => x.turns.at(-1)?.user.text === 'And then this' && !x.summary.running, 'sent');
  assert.equal((await get(s, s.threadId)).queueHeld, undefined);
});

test('an attachment that changed while its message waited goes only on the person\'s word', async () => {
  const s = await thread({ harness: 'harness-pi' });
  const made = value(await s.host.call('material.attach', { projectId: s.p.id, name: 'plan.md', base64: b64('one'), mediaType: 'text/markdown' }));
  await held(s);
  value(await s.host.call('queue.add', { threadId: s.threadId, text: 'Use the plan', attachments: [made.id], settings, clientKey: 'p' }));
  // A new version, as a Save makes; an original is never edited through the api.
  const { readFileSync, writeFileSync } = await import('node:fs');
  const meta = `${s.home}/material/${made.id}/meta.json`;
  const entry = JSON.parse(readFileSync(meta, 'utf8'));
  writeFileSync(meta, JSON.stringify({ ...entry, current: 2, versions: [...entry.versions, { ...entry.versions[0], n: 2 }] }));
  writeFileSync(`${s.home}/material/${made.id}/versions/2`, 'two');
  holding = false;
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running && !!x.queue?.[0]?.problem, 'held for the person');
  assert.match(t.queue![0].problem!, /changed after you queued/);
  assert.match(t.queueHeld ?? '', /changed after you queued/, 'the person is shown how to answer it');
  value(await sendNow(s, t.queue![0]));
  const sent = await until(() => get(s, s.threadId), (x) => x.turns.at(-1)?.user.text === 'Use the plan' && !x.summary.running, 'sent');
  assert.equal(sent.turns.at(-1)!.user.attachments[0].version, 2);
});

test('a queued turn whose thread file cannot be saved still runs from the journal, and hands over no read it could not save', async () => {
  const s = await thread({ writeDelayMs: 300 });
  const source=value(await s.host.call('material.attach',{projectId:s.p.id,name:'queued-source.md',base64:b64('A known source the queued turn must read.'),mediaType:'text/markdown'}));
  assert.ok((await s.host.call('material.list',{projectId:s.p.id})).some(entry=>entry.id===source.id),'the read does not depend on the earlier turn winning a race with Stop');
  value(await slow(s));
  value(await queued(s, 'Goes despite the file'));
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running, 'stopped');
  const { chmodSync } = await import('node:fs');
  chmodSync(`${s.home}/threads`, 0o500);
  try {
    assert.equal((await sendNow(s, t.queue![0])).ok, true);
    await until(() => get(s, s.threadId), (x) => x.turns.at(-1)?.user.text === 'Goes despite the file' && !x.summary.running, 'ran');
  } finally { chmodSync(`${s.home}/threads`, 0o700); }
  const ran = await get(s, s.threadId);
  assert.ok(!ran.queue?.length, 'nothing is stranded in the queue');
  // Its read could not be put on disk, so its text was not handed over: the turn ends there and says so.
  assert.equal(ran.turns.at(-1)!.status, 'stopped');
  assert.match(ran.turns.at(-1)!.answer!.text, /failed/);
});

test('deleting a chat is refused while a message waits in it', async () => {
  const s = await thread({ writeDelayMs: 300 });
  value(await slow(s));
  value(await queued(s, 'Held'));
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  await until(() => get(s, s.threadId), (x) => !x.summary.running, 'stopped');
  const r = await s.host.call('threads.delete', { id: s.threadId });
  assert.equal(r.ok, false);
});

test('on an engine that cannot confirm, steering is refused by name and nothing is claimed', async () => {
  const s = await thread({ writeDelayMs: 300 });
  assert.equal((await get(s, s.threadId)).steering?.available, false);
  value(await slow(s));
  const r = await s.host.call('turns.steer', { threadId: s.threadId, text: 'Also this', clientKey: 's' });
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, 'NOT_AVAILABLE']);
  assert.match(!r.ok ? r.detail : '', /cannot take/);
  const t = await get(s, s.threadId);
  assert.equal(t.turns.at(-1)!.steers, undefined);
  assert.match(t.steering?.detail ?? '', /cannot take/);
});

test('words steered at a running Pi turn reach the model, are confirmed and are in the next turn\'s history', async () => {
  const s = await thread({ harness: 'harness-pi' });
  assert.equal((await get(s, s.threadId)).steering?.available, true);
  await held(s);
  const before = model.requests.length;
  const receipt = value(await s.host.call('turns.steer', { threadId: s.threadId, text: 'Use the blue one', clientKey: 's' }));
  assert.equal(receipt.state, 'sending', 'a hand-over is not a delivery');
  const again = value(await s.host.call('turns.steer', { threadId: s.threadId, text: 'Use the blue one', clientKey: 's' }));
  assert.equal(again.id, receipt.id, 'the same key is the same words');
  holding = false;
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running, 'finished');
  const turn = t.turns.at(-1)!;
  assert.deepEqual(turn.steers?.map((x) => [x.text, x.state]), [['Use the blue one', 'delivered']]);
  assert.equal(model.requests.slice(before).filter((r) => r.body.includes('Use the blue one')).length >= 1, true);
  assert.match(turn.answer!.text, /Use the blue one/);
  const told = (await import('node:fs')).readFileSync(`${s.home}/thread-journal.jsonl`, 'utf8').split('\n').filter((l) => l.includes('"turn.told"') && l.includes('"steer"'));
  assert.equal(told.length, 1, 'the words are on the record of what the turn was told');
  value(await s.host.call('turns.send', { projectId: s.p.id, threadId: s.threadId, text: 'And now?', attachments: [], settings, clientKey: 'n' }));
  await idle(s.host, s.threadId);
  assert.ok(model.requests.at(-1)!.body.includes('Use the blue one'), 'steered words stay in history');
});

/** An engine with a controllable answer to `deliver`. */
function controlled(answer: () => Promise<import('../src/ports/harness.ts').SteerOutcome>): { engine: HarnessV1; finish(): void; started: Promise<void>; given: string[] } {
  let finish!: () => void; let started!: () => void;
  const ended = new Promise<void>((r) => { finish = r; });
  const began = new Promise<void>((r) => { started = r; });
  const given: string[] = [];
  const engine: HarnessV1 = {
    specificationVersion: 'v1', id: 'controlled', label: 'Controlled', steers: true,
    start() {
      started();
      return { events: (async function* () {})(), steer() {}, stop() { finish(); }, deliver: (t) => { given.push(t); return answer(); },
        outcome: ended.then(() => ({ status: 'done' as const, answer: 'Finished.', usage: { input: 0, output: 0 } })) };
    },
  };
  return { engine, finish, started: began, given };
}

test('words the engine says did not arrive go back to the queue, never claimed, and are sent once', async () => {
  const c = controlled(async () => ({ outcome: 'NOT_DELIVERED', detail: 'The turn ended first.' }));
  const { steeredHost } = await import('./steer-host.ts');
  const s = await steeredHost(c.engine, open);
  await c.started;
  value(await s.host.call('turns.steer', { threadId: s.threadId, text: 'Too late', clientKey: 's' }));
  const queuedBack = await until(() => s.get(), (x) => x.queue?.length === 1, 'back in the queue');
  assert.deepEqual([queuedBack.queue![0].text, queuedBack.queue![0].fromSteer], ['Too late', true]);
  assert.equal(queuedBack.turns.at(-1)!.steers![0].state, 'not-delivered');
  c.finish();
  await until(() => s.get(), (x) => x.turns.some((t) => t.user.text === 'Too late'), 'sent as the next message');
  assert.deepEqual((await s.get()).turns.filter((t) => t.user.text === 'Too late').length, 1);
});

test('words the engine cannot account for are UNKNOWN: not delivered, not requeued, not resent', async () => {
  const c = controlled(async () => ({ outcome: 'UNKNOWN', detail: 'The connection closed before it answered.' }));
  const { steeredHost } = await import('./steer-host.ts');
  const s = await steeredHost(c.engine, open);
  await c.started;
  value(await s.host.call('turns.steer', { threadId: s.threadId, text: 'Did you get this', clientKey: 's' }));
  const t = await until(() => s.get(), (x) => x.turns.at(-1)!.steers?.[0].state !== 'sending', 'settled');
  assert.equal(t.turns.at(-1)!.steers![0].state, 'unknown');
  assert.deepEqual(t.queue ?? [], []);
  c.finish();
  await until(() => s.get(), (x) => !x.summary.running, 'finished');
  assert.equal(c.given.length, 1);
});

test('an engine that never answers leaves the words unknown when the turn ends', async () => {
  const c = controlled(() => new Promise(() => {}));
  const { steeredHost } = await import('./steer-host.ts');
  const s = await steeredHost(c.engine, open);
  await c.started;
  value(await s.host.call('turns.steer', { threadId: s.threadId, text: 'Anyone there', clientKey: 's' }));
  c.finish();
  const t = await until(() => s.get(), (x) => !x.summary.running, 'finished');
  assert.equal(t.turns.at(-1)!.steers![0].state, 'unknown');
});

test('unconfirmed words are neither told to a resumed turn nor replayed; confirmed ones are', async () => {
  const { createParallelWork } = await import('../src/composition/parallel-work.ts');
  const { replay } = await import('../src/composition/withdrawal.ts');
  const steers = [{ id: 'a', text: 'Confirmed words', at: 'x', state: 'delivered' as const }, { id: 'b', text: 'Unconfirmed words', at: 'x', state: 'unknown' as const }, { id: 'c', text: 'Returned words', at: 'x', state: 'not-delivered' as const }];
  const turn = { id: 't', user: { text: 'Go', attachments: [], at: 'x' }, steers, effects: [], work: { steps: [], harness: 'x', startedAt: 'x' }, status: 'running', side: false } as unknown as Turn;
  const thread = { summary: { id: 'th', projectId: 'p' }, turns: [turn], sideTurns: [], clientKeys: [] };
  const threads = new Map([['th', thread]]);
  const material = { load: () => null, list: () => [] };
  const work = createParallelWork({ threads, running: new Map(), material, native: () => false, journal: { read: () => [], append: (b: object) => b } } as never);
  const told = work.tell(thread as never, turn).text ?? '';
  assert.match(told, /Confirmed words/);
  assert.doesNotMatch(told, /Unconfirmed|Returned/);
  const history = replay([turn], material as never, 'p').history.map((h) => h.text).join('\n');
  assert.match(history, /Confirmed words/);
  assert.doesNotMatch(history, /Unconfirmed|Returned/);
});

test('steering after Stop is refused, and a stopped turn takes nothing', async () => {
  const c = controlled(async () => ({ outcome: 'DELIVERED' }));
  const { steeredHost } = await import('./steer-host.ts');
  const s = await steeredHost(c.engine, open);
  await c.started;
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  const r = await s.host.call('turns.steer', { threadId: s.threadId, text: 'After stop', clientKey: 's' });
  assert.equal(r.ok, false);
  assert.equal(c.given.length, 0);
});

// ---- Bringing a worker's documents back -------------------------------------

async function worker(s: Hosted, words = 'Write an editable brief', key = 'w') {
  const kid = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: words, role: 'worker', clientKey: key }));
  await idle(s.host, kid.threadId);
  const parent = await until(() => get(s, s.threadId), (x) => x.children?.find((c) => c.threadId === kid.threadId)?.running === false, 'worker finished');
  return { kid, view: parent.children!.find((c) => c.threadId === kid.threadId)! };
}
const merge = (s: Hosted, childThreadId: string, doc: { materialId: string; version: number; current: number }, clientKey = 'm') =>
  s.host.call('children.merge', { parentThreadId: s.threadId, childThreadId, materialId: doc.materialId, version: doc.version, baseVersion: doc.current, clientKey });

test('a finished worker\'s document comes into the parent as one turn, adding no version, with receipts and reads kept', async () => {
  const s = await thread({ harness: 'harness-pi' });
  const note = value(await s.host.call('material.attach', { projectId: s.p.id, name: 'note.md', base64: b64('source'), mediaType: 'text/markdown' }));
  const { kid, view } = await worker(s, 'Read the note and write');
  const doc = view.documents![0];
  assert.deepEqual([doc.name, doc.state, doc.by, doc.version === doc.current], ['brief.md', 'ready', 'agent', true]);
  assert.equal(doc.detail, undefined);
  const before = (await get(s, s.threadId)).turns.length;
  const r = value(await merge(s, kid.threadId, doc));
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running, 'merged');
  assert.equal(t.turns.length, before + 1);
  const turn = t.turns.find((x) => x.id === r.turnId)!;
  assert.equal(turn.status, 'done', turn.answer?.text ?? 'no answer');
  assert.equal(turn.merge?.outcome, 'adopted');
  assert.deepEqual(turn.merge?.receipts.map((x) => [x.target, x.outcome]), [['brief.md', 'DONE']]);
  assert.ok(turn.merge?.reads.some((x) => x.id === note.id), 'what the worker read stays with it');
  assert.ok(turn.reads?.some((x) => x.id === note.id), 'and counts as this turn\'s');
  assert.deepEqual(turn.answer?.files.map((f) => [f.name, f.version]), [['brief.md', doc.version]]);
  const entry = value(await s.host.call('material.read', { id: doc.materialId })).entry;
  assert.equal(entry.current, doc.version, 'no version was made');
  assert.equal(entry.versions[0].by, 'agent', 'an agent\'s version stays an agent\'s');
  assert.ok(t.card.changes.files >= 1, 'it shows in this thread\'s changes');
  assert.equal(t.children![0].documents![0].state, 'merged');
  const twice = await merge(s, kid.threadId, doc, 'other');
  assert.equal(twice.ok, true);
  assert.equal(!twice.ok ? '' : twice.value.turnId, r.turnId, 'bringing it back again is the same act');
  assert.equal((await get(s, s.threadId)).turns.length, t.turns.length);
});

test('a document the person edited since stands: the worker\'s version lands beside it', async () => {
  const s = await thread();
  const { kid, view } = await worker(s);
  const doc = view.documents![0];
  const workerText = value(await s.host.call('material.read', { id: doc.materialId, version: doc.version })).text!;
  const mine = value(await s.host.call('material.save', { id: doc.materialId, text: 'Mine', baseVersion: doc.current }));
  const fresh = (await get(s, s.threadId)).children![0].documents![0];
  assert.deepEqual([fresh.state, fresh.by, fresh.current], ['stale', 'person', mine.current]);
  const old = await merge(s, kid.threadId, doc);
  assert.deepEqual([old.ok, !old.ok && old.reason], [false, 'STALE_BASE'], 'a view from before the edit changes nothing');
  const r = value(await merge(s, kid.threadId, fresh, 'after'));
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running, 'merged');
  const turn = t.turns.find((x) => x.id === r.turnId)!;
  assert.equal(turn.status, 'done', turn.answer?.text ?? 'no answer');
  assert.equal(turn.merge?.outcome, 'beside');
  assert.match(turn.work.harness, /no model called/);
  assert.ok(turn.work.steps.some((w) => w.kind === 'read' && w.label === `Read brief.md v${doc.version}`), 'what it copied is on the record');
  assert.equal(value(await s.host.call('material.read', { id: doc.materialId })).text, 'Mine', 'the person\'s edit is untouched');
  assert.equal(value(await s.host.call('material.read', { id: doc.materialId })).entry.current, mine.current);
  const beside = (await s.host.call('material.list', { projectId: s.p.id })).find((e) => e.name === turn.merge!.beside!.name)!;
  assert.ok(beside.kept, 'the person asked for it, so it is not temporary');
  assert.match(beside.name, /brief \(revision of v1\)\.md/);
  assert.equal(value(await s.host.call('material.read', { id: beside.id })).text, workerText);
  assert.equal(beside.versions[0].by, 'agent');
  assert.equal(beside.class, 'working');
  assert.deepEqual(turn.effects.map((e) => [e.target, e.outcome]), [[beside.name, 'DONE']]);
  assert.ok(turn.effects[0].key, 'the landing has its own receipt');
  assert.deepEqual(turn.merge?.receipts.map((x) => x.outcome), ['DONE']);
});

test('an adoption is decided when it happens: a Stop or a Save that got there first brings nothing back', async () => {
  const { createParallelWork } = await import('../src/composition/parallel-work.ts');
  const marked: string[] = [];
  const current = { n: 1 };
  const entry = { id: 'd', current: 1, hidden: false };
  const material = { load: () => ({ ...entry, current: current.n }), list: () => [], mark: (id: string) => marked.push(id) };
  const work = createParallelWork({ home: freshHome(), threads: new Map(), running: new Map(), material, native: () => false, journal: { read: () => [] } } as never);
  const turn = () => ({ reads: [], merge: { threadId: 'c', turnId: 't', materialId: 'd', name: 'brief.md', version: 1, outcome: 'adopted', receipts: [], reads: [] } }) as unknown as Turn;
  const stopped = turn();
  const stop = new AbortController(); stop.abort();
  await work.carryMerge({} as never, stopped, {} as never, stop.signal);
  assert.equal(stopped.status, 'stopped');
  current.n = 2;
  const moved = turn();
  await work.carryMerge({} as never, moved, {} as never, new AbortController().signal);
  assert.equal(moved.status, 'refused');
  assert.match(moved.answer!.text, /Your version stands/);
  current.n = 1;
  entry.hidden = true;
  const setAside = turn();
  await work.carryMerge({} as never, setAside, {} as never, new AbortController().signal);
  assert.equal(setAside.status, 'refused');
  assert.match(setAside.answer!.text, /held or set aside/);
  assert.deepEqual(marked, [], 'none of them claimed anything');
});

test('a version that is not text is refused rather than copied inexactly', async () => {
  const s = await thread();
  const { kid, view } = await worker(s);
  const doc = view.documents![0];
  value(await s.host.call('material.save', { id: doc.materialId, text: 'Mine', baseVersion: doc.current }));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${s.home}/material/${doc.materialId}/versions/${doc.version}`, Buffer.from([0xff, 0xfe, 0x00]));
  const fresh = (await get(s, s.threadId)).children![0].documents![0];
  const r = await merge(s, kid.threadId, fresh);
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, 'INVALID']);
});

test('a worker\'s read of another version of a source the parent also inherited is kept', async () => {
  const s = await thread({ harness: 'harness-pi' });
  value(await s.host.call('turns.send', { projectId: s.p.id, threadId: s.threadId, text: 'Write the source note', attachments: [], settings, clientKey: 'source-note' }));
  await idle(s.host, s.threadId);
  const note = (await s.host.call('material.list', { projectId: s.p.id })).find(entry => entry.name === 'note.md')!;
  value(await s.host.call('turns.send', { projectId: s.p.id, threadId: s.threadId, text: 'Read the note without writing', attachments: [], settings, clientKey: 'parent-read' }));
  await idle(s.host, s.threadId);
  const parent = await get(s, s.threadId);
  assert.ok(parent.turns.at(-1)!.reads!.some(read => read.id === note.id && read.version === 1));
  value(await s.host.call('material.save', { id: note.id, text: 'updated source', baseVersion: 1 }));
  const { kid, view } = await worker(s, 'Read the note and write');
  const r = value(await merge(s, kid.threadId, view.documents![0]));
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running, 'merged');
  assert.deepEqual(t.turns.find((x) => x.id === r.turnId)!.reads!.filter((x) => x.id === note.id).map((x) => x.version).sort(), [1, 2]);
});

test('a worker with an UNKNOWN cannot be merged', async () => {
  const { seen, atPoint } = inWrite();
  const s = await thread({ writeDelayMs: 1500, atPoint });
  const before = seen.writes;
  const kid = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', clientKey: 'w' }));
  await until(async () => seen.writes, (n) => n > before, 'write under way');
  value(await s.host.call('turns.stop', { threadId: kid.threadId }));
  const t = await until(() => get(s, s.threadId), (x) => x.children?.[0].running === false, 'stopped');
  assert.equal(t.children![0].unknown, 1);
  const r = await s.host.call('children.merge', { parentThreadId: s.threadId, childThreadId: kid.threadId, materialId: 'whatever', version: 1, baseVersion: 1, clientKey: 'm' });
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, 'UNKNOWN_OUTCOME_HELD']);
});

test('a worker whose source was withdrawn is withheld and cannot be merged, and a merged document leaves history with its source', async () => {
  const s = await thread({ harness: 'harness-pi' });
  const note = value(await s.host.call('material.attach', { projectId: s.p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  const { kid, view } = await worker(s, 'Read the note and write');
  const doc = view.documents![0];
  value(await s.host.call('material.lifecycle', { id: note.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  const t = await get(s, s.threadId);
  assert.equal(t.children![0].handover?.withheld, true);
  assert.equal(t.children![0].documents![0].state, 'blocked');
  const r = await merge(s, kid.threadId, doc);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.detail : '', /withheld|withdrawn/);
});

test('a merge turn leaves a later withdrawal honest', async () => {
  const s = await thread({ harness: 'harness-pi' });
  const note = value(await s.host.call('material.attach', { projectId: s.p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  const { kid, view } = await worker(s, 'Read the note and write');
  const r = value(await merge(s, kid.threadId, view.documents![0]));
  await until(() => get(s, s.threadId), (x) => !x.summary.running, 'merged');
  value(await s.host.call('material.lifecycle', { id: note.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  const seen = model.requests.length;
  value(await s.host.call('turns.send', { projectId: s.p.id, threadId: s.threadId, text: 'Anything new?', attachments: [], settings, clientKey: 'next' }));
  await idle(s.host, s.threadId);
  const t = await get(s, s.threadId);
  assert.equal(t.turns.find((x) => x.id === r.turnId)!.status, 'done');
  assert.ok(!model.requests.slice(seen).some((q) => q.body.includes('No new version was made')), 'the merge answer left history with its source');
});

test('a running worker, a reviewer, a stranger\'s document and a running parent are refused by name', async () => {
  const s = await thread({ writeDelayMs: 300 });
  const kid = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', clientKey: 'w' }));
  const running = await s.host.call('children.merge', { parentThreadId: s.threadId, childThreadId: kid.threadId, materialId: 'x', version: 1, baseVersion: 1, clientKey: 'a' });
  assert.deepEqual([running.ok, !running.ok && running.reason], [false, 'NOT_AVAILABLE']);
  await idle(s.host, kid.threadId);
  const other = await s.host.call('children.merge', { parentThreadId: kid.threadId, childThreadId: s.threadId, materialId: 'x', version: 1, baseVersion: 1, clientKey: 'b' });
  assert.equal(other.ok, false);
  const none = await s.host.call('children.merge', { parentThreadId: s.threadId, childThreadId: kid.threadId, materialId: 'x', version: 1, baseVersion: 1, clientKey: 'c' });
  assert.deepEqual([none.ok, !none.ok && none.reason], [false, 'NOT_FOUND']);
});

test('a merge landing a kill cut short keeps one effect and resumes as a turn', async () => {
  const s = await thread();
  const { kid, view } = await worker(s);
  const doc = view.documents![0];
  value(await s.host.call('material.save', { id: doc.materialId, text: 'Mine', baseVersion: doc.current }));
  const fresh = (await get(s, s.threadId)).children![0].documents![0];
  value(await merge(s, kid.threadId, fresh));
  const t = await until(() => get(s, s.threadId), (x) => !x.summary.running, 'merged');
  s.host.close();
  await hostClosed(s.home);
  const again = open(s.home);
  const reopened = value(await again.host.call('threads.get', { id: s.threadId }));
  assert.equal(reopened.turns.length, t.turns.length);
  assert.equal(reopened.turns.at(-1)!.merge?.outcome, 'beside', 'the journal has it');
  assert.equal(reopened.children![0].documents![0].state, 'merged');
});

test('a fork takes no merge', async () => {
  const s = await thread();
  const { kid, view } = await worker(s);
  value(await merge(s, kid.threadId, view.documents![0]));
  await until(() => get(s, s.threadId), (x) => !x.summary.running, 'merged');
  const fork = value(await s.host.call('threads.fork', { id: s.threadId, clientKey: 'f' }));
  const forked = await get(s, fork.id);
  assert.ok(forked.turns.every((x) => !x.merge));
});

test('the native engine says, before anyone asks, that a reviewer cannot run on it', async () => {
  const c = controlled(async () => ({ outcome: 'DELIVERED' }));
  const { steeredHost } = await import('./steer-host.ts');
  const native = await steeredHost(c.engine, open);
  const { reviewer } = await native.get();
  c.finish();
  assert.equal(reviewer?.available, false);
  assert.match(reviewer?.detail ?? '', /read-only reviewer/);
  const s = await thread();
  assert.equal((await get(s, s.threadId)).reviewer, undefined);
});
