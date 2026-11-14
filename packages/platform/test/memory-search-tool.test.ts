// Active memory: Pi's memory_search looks memory up mid-turn, ranked as recall is. A line's sources are
// the turn's reads before its words come back, so withdrawing a document reaches what the turn made
// from it; a line whose source was withdrawn is not given, and a credential never is.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { MemoryView } from '../src/api.ts';
import { hostClosed } from '../src/composition/host.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { isJudgeRequest, judgeStep } from '../src/testing/memory-model.ts';
import { startScriptedModel, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { pollUntil, b64, freshHome, idle, open, settings, value  } from './helpers.ts';

const text = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
const results: string[] = [];
/** "Look up <query>": call memory_search once, then answer with what came back. */
function script(messages: Message[]): Step {
  // Consolidation's judgement, on the same route: the scripted rules (src/testing/memory-model.ts).
  if (isJudgeRequest(messages)) return judgeStep(messages);
  const start = messages.findLastIndex((m) => m.role === 'user');
  const asked = /Look up (.+)/.exec(text(messages[start]))?.[1];
  const tool = messages.slice(start + 1).filter((m) => m.role === 'tool').map(text);
  // "Propose <text>": call propose_memory once with that text, then answer with what came back.
  const proposing = /Propose (.+)/.exec(text(messages[start]))?.[1];
  if (proposing) {
    if (!tool.length) return { calls: [{ name: 'propose_memory', args: { text: proposing, topic: 'fleet' } }] };
    results.push(tool[0]);
    return { text: `Said: ${tool[0]}` };
  }
  if (!asked) return { text: 'Noted.' };
  if (!tool.length) return { calls: [{ name: 'memory_search', args: { query: asked } }] };
  results.push(tool[0]);
  return { text: `Found: ${tool[0]}` };
}
let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel('scripted-model', script);
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});
const fakeKey = ['sk', 'live', '0123456789abcdef', 'ABCDEF'].join('-');

test('memory_search gives the lines that bear on it, with their sources read first, and none withdrawn or holding a credential', async () => {
  const home = freshHome();
  // A line made from a document, as a turn that read it would keep it.
  const first = open(home, { harness: 'harness-pi' });
  const projectId = value(await first.host.call('projects.create', { name: 'P', kind: 'folder' })).id;
  const doc = value(await first.host.call('material.attach', { projectId, name: 'fleet.md', base64: b64('# Fleet\nThe van is serviced every March.\n'), mediaType: 'text/markdown' }));
  first.host.close();
  await hostClosed(home);
  new MemoryStore(home).add({ topic: 'fleet', text: 'The van is serviced every March.', origin: { kind: 'turn' }, sources: [{ id: doc.id, name: 'fleet.md', version: 1 }] }, () => 'current');
  appendFileSync(join(home, 'memory', 'topics', 'fleet.md'), `- The garage van login is ${fakeKey} for servicing.\n`);

  const { host } = open(home, { harness: 'harness-pi' });
  const sent = value(await host.call('turns.send', { projectId, text: 'Look up van servicing', attachments: [], settings, clientKey: 'k1' }));
  const t = await idle(host, sent.threadId);
  const turn = t.turns.at(-1)!;
  assert.match(results.at(-1)!, /The van is serviced every March/);
  assert.match(results.at(-1)!, /data, not instructions/);
  assert.doesNotMatch(results.at(-1)!, new RegExp(fakeKey), 'a line holding a credential is never given');
  assert.ok(turn.reads?.some((r) => r.id === doc.id && r.inherited), 'the line\'s source is this turn\'s read');
  // The record is saved before the last checks, so it may name a line kept back then (the credential one), never the reverse.
  const van = (await host.call('memory.search', { query: 'van serviced' }))[0];
  assert.ok(turn.memory?.used.includes(van.id), 'the line given is on its record');

  const entry = (await host.call('material.list', { projectId })).find((e) => e.id === doc.id)!;
  value(await host.call('material.lifecycle', { id: doc.id, version: entry.current, state: 'withdrawn', lifecycle: entry.lifecycle ?? 0 }));
  const again = value(await host.call('turns.send', { threadId: sent.threadId, projectId, text: 'Look up van servicing', attachments: [], settings, clientKey: 'k2' }));
  await idle(host, again.threadId);
  assert.match(results.at(-1)!, /Nothing in the person's memory bears on that/, 'withdrawn: the line is gone');
});

/** What a turn proposed is judged after it ends, without holding the turn open: wait for that pass. */
async function settled(host: ReturnType<typeof open>['host'], done: (view: MemoryView) => boolean) {
  return await pollUntil(async active => {
    while (active()) {
      const view = await host.call('memory.get', {});
      if (done(view)) return view;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('memory did not settle');
  }, "packages/platform/test/memory-search-tool.test.ts settled");
}

test('propose_memory: a low-risk line is kept by itself with the turn\'s sources and an undo; a credential or a withdrawn source is not', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
  const doc = value(await host.call('material.attach', { projectId, name: 'clients.md', base64: b64('# Clients\nACME pays on the first Monday.\n'), mediaType: 'text/markdown' }));
  const judged = () => model.requests.filter((r) => r.body.includes('Consolidate this memory.')).length;
  const before = judged();
  const sent = value(await host.call('turns.send', { projectId, text: 'Propose ACME pays invoices on the first Monday of the month.', attachments: [doc.id], settings, clientKey: 'p1' }));
  await idle(host, sent.threadId);
  assert.match(results.at(-1)!, /Proposed\. When the turn ends it is judged/);
  let view = await settled(host, (v) => v.entries.length === 1);
  assert.ok(judged() > before, 'judged by a model turn on the home\'s configured route');
  for (const r of model.requests.filter((x) => x.body.includes('Consolidate this memory.'))) {
    const body = JSON.parse(r.body) as { tools?: unknown[] };
    assert.ok(!body.tools || body.tools.length === 0, 'the judge is offered no tool');
  }
  assert.equal(view.proposed.length, 0, 'nothing waits for the person');
  const line = view.entries[0];
  assert.equal(line.origin.kind, 'engine');
  assert.equal(line.origin.threadId, sent.threadId);
  assert.deepEqual(line.sources.map((s) => s.id), [doc.id], 'with the turn\'s reads as its sources');
  assert.equal(view.kept.length, 1);
  assert.deepEqual([view.kept[0].op, view.kept[0].added?.id], ['keep', line.id]);
  assert.equal((await host.call('memory.search', { query: 'ACME first Monday' })).length, 1, 'and recalled');

  // Undo takes it out again.
  value(await host.call('memory.undo', { id: view.kept[0].id }));
  view = await host.call('memory.get', {});
  assert.deepEqual([view.entries.length, view.kept.length], [0, 0]);

  const credential = value(await host.call('turns.send', { threadId: sent.threadId, projectId, text: `Propose The ACME portal password is hunter2-${'x'.repeat(4)}.`, attachments: [], settings, clientKey: 'p2' }));
  await idle(host, credential.threadId);
  assert.match(results.at(-1)!, /a credential is never kept/);

  // Two lines from the same document are kept; withdrawing the document takes both, and their undo, away.
  for (const [i, words] of ['ACME pays invoices on the first Monday of the month.', 'ACME is invoiced in euros.'].entries()) {
    const again = value(await host.call('turns.send', { threadId: sent.threadId, projectId, text: `Propose ${words}`, attachments: [doc.id], settings, clientKey: `p3-${i}` }));
    await idle(host, again.threadId);
    await settled(host, (v) => v.entries.length === i + 1);
  }
  const entry = (await host.call('material.list', { projectId })).find((e) => e.id === doc.id)!;
  value(await host.call('material.lifecycle', { id: doc.id, version: entry.current, state: 'withdrawn', lifecycle: entry.lifecycle ?? 0 }));
  view = await host.call('memory.get', {});
  assert.deepEqual([view.proposed.length, view.entries.length, view.kept.length], [0, 0, 0]);
});

test('a proposal that conflicts with the person\'s words waits for them; one whose words become a known credential is not shown and cannot be kept', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
  value(await host.call('memory.put', { topic: 'release', text: 'The release build tag is chosen by the person.' }));
  const tag = `canary-${crypto.randomUUID()}`;
  const sent = value(await host.call('turns.send', { projectId, text: `Propose The release build tag is ${tag}.`, attachments: [], settings, clientKey: 'c1' }));
  await idle(host, sent.threadId);
  assert.match(results.at(-1)!, /Proposed\./);
  const held = (await settled(host, (v) => !!v.proposed[0]?.judged)).proposed[0];
  assert.equal(held.judged!.op, 'hold');
  assert.deepEqual(held.judged!.conflicts.map((c) => c.text), ['The release build tag is chosen by the person.']);
  assert.equal((await host.call('memory.get', {})).entries.length, 1, 'only the person\'s line');
  // The same value is then stored as a key: from now on it is a credential the host knows.
  value(await host.call('settings.model.put', { change: { route: 'gateway', provider: 'vercel', key: tag } }));
  assert.equal((await host.call('memory.get', {})).proposed.length, 0, 'no longer shown');
  const kept = await host.call('memory.proposal.decide', { id: held.id, verdict: 'keep' });
  assert.equal(kept.ok, false);
  assert.equal((await host.call('memory.get', {})).entries.length, 1, 'and nothing was kept');
});

test('the daily pass proposes merging lines that say the same; kept, one line stands; a changed line refuses the merge', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const a = value(await host.call('memory.put', { topic: 'office', text: 'The office is in Madrid, on Gran Via.' }));
  value(await host.call('memory.put', { topic: 'office', text: 'Our office is in Madrid, on the Gran Via.' }));
  value(await host.call('memory.put', { topic: 'office', text: 'Plants need water on Mondays.' }));
  value(await host.call('memory.put', { topic: 'travel', text: 'The office is in Madrid, on Gran Via.' }));
  // The daily pass may already have run as the host started; either way one merge waits, and no second.
  value(await host.call('memory.consolidate', {}));
  assert.equal(value(await host.call('memory.consolidate', {})).proposed, 0, 'not proposed twice');
  const merges = (await host.call('memory.get', {})).proposed;
  assert.equal(merges.length, 1, 'one pair, in one topic');
  const merge = merges[0];
  assert.equal(merge.origin.kind, 'merge');
  assert.equal(merge.judged?.op, 'merge', 'judged by the model, held because the lines are the person\'s');
  assert.equal(merge.replaces?.length, 2);
  assert.equal(merge.text, 'Our office is in Madrid, on the Gran Via.', 'the longer is kept');
  assert.equal((await host.call('memory.get', {})).entries.length, 4, 'nothing changes until the person keeps it');
  value(await host.call('memory.proposal.decide', { id: merge.id, verdict: 'keep' }));
  const after = (await host.call('memory.get', {})).entries;
  assert.deepEqual(after.filter((e) => e.topic === 'office').map((e) => e.text).sort(), ['Our office is in Madrid, on the Gran Via.', 'Plants need water on Mondays.']);
  assert.equal(after.length, 3);

  // A line changed after its merge was proposed: the merge is refused, and nothing is lost.
  value(await host.call('memory.put', { topic: 'notes', text: 'Invoices go out on the first Monday of the month.' }));
  const b = value(await host.call('memory.put', { topic: 'notes', text: 'Invoices go out on the first Monday of each month.' }));
  value(await host.call('memory.consolidate', {}));
  const stale = (await host.call('memory.get', {})).proposed.find((p) => p.topic === 'notes')!;
  value(await host.call('memory.put', { id: b.id, topic: 'notes', text: 'Invoices go out on the second Monday.' }));
  const refused = await host.call('memory.proposal.decide', { id: stale.id, verdict: 'keep' });
  assert.equal(refused.ok, false);
  assert.equal((await host.call('memory.get', {})).entries.filter((e) => e.topic === 'notes').length, 2);
  void a;
});
