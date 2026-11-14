import { syntheticMaterialReader } from './fixtures/synthetic-material-reader.ts';
// Withdrawing a person's attached original: no later turn receives it, work in progress is held rather
// than thrown away, the person and the next turn are told, and every version stays.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { Turn } from '../src/api.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import { originalWrite, retainOriginalWrite } from '../src/composition/thread-custody.ts';
import { classifyRecovered, holdRecovered } from '../src/composition/withdrawal.ts';
import { workNow } from '../src/composition/work-now.ts';
import type { HarnessV1, ToolHost, TurnOutcome, TurnRequest } from '../src/ports/harness.ts';
import { sha256 } from '../src/stub/fsx.ts';
import { MaterialStore } from '../src/stub/material.ts';
import type { Gateway } from '../src/stub/harness.ts';
import { startScriptedModel, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { pollUntil, freshHome, idle, open, settings, value  } from './helpers.ts';

const SECRET = 'Kestrel-7731 closes Lisbon';
const seen = (m: ScriptedModel, from = 0) => m.requests.slice(from).map((r) => r.body).join('\n');

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel();
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

async function project() {
  const { host, home } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'Withdraw', kind: 'folder' }));
  const attach = (name: string, text: string) => host.call('material.attach', { projectId: p.id, name, base64: Buffer.from(text).toString('base64'), mediaType: 'text/markdown' }).then(value);
  return { host, home, projectId: p.id, attach };
}

test('a withdrawn original reaches no later turn, and the person, the record and the next turn all say so', async () => {
  const { host, projectId, attach } = await project();
  const hiring = await attach('hiring.md', `${SECRET}\n`);
  const sales = await attach('sales.md', 'Marlin\n');
  const first = value(await host.call('turns.send', { projectId, text: 'Write an editable brief', attachments: [hiring.id, sales.id], settings, clientKey: 'a' }));
  await idle(host, first.threadId);
  assert.ok(seen(model).includes('Kestrel'));

  const withdrawn = value(await host.call('material.lifecycle', { id: hiring.id, version: hiring.current, state: 'withdrawn', lifecycle: hiring.lifecycle ?? 0 }));
  assert.equal(withdrawn.hidden, true);
  assert.equal(withdrawn.withdrawals?.length, 1);
  assert.equal(withdrawn.withdrawals?.[0]?.version, 1);
  assert.ok(withdrawn.withdrawals?.[0]?.at);

  const list = await host.call('material.list', { projectId });
  assert.deepEqual(list.filter((m) => m.name === 'hiring.md'), []);
  const now = await host.call('work.now', { projectId });
  assert.deepEqual(now.withdrawn.map((d) => [d.name, d.withdrawnAt]), [['hiring.md', withdrawn.withdrawals![0]!.at]]);
  assert.deepEqual(now.withdrawn[0]!.mayCarry, ['brief.md']);
  assert.deepEqual(now.retired, []);
  // Every version is kept, for the person, unchanged.
  assert.equal(value(await host.call('material.read', { id: hiring.id, version: 1 })).text, `${SECRET}\n`);

  const from = model.requests.length;
  const second = value(await host.call('turns.send', { threadId: first.threadId, projectId, text: 'What have we got so far?', attachments: [], settings, clientKey: 'b' }));
  const thread = await idle(host, first.threadId);
  assert.equal(second.threadId, first.threadId);
  const sent = seen(model, from);
  assert.ok(/hiring\.md was withdrawn/.test(sent), 'the next turn is told');
  assert.ok(/brief\.md/.test(sent), 'the next turn is told what may carry it');
  const turn = thread.turns.at(-1)!;
  assert.ok(turn.work.steps.some((s) => /hiring\.md was withdrawn/.test(s.label)), 'the person sees it on the turn');
  assert.ok(!turn.work.steps.some((s) => /^Read hiring\.md/.test(s.label)));
});

test('a withdrawn original cannot be attached to a new turn', async () => {
  const { host, projectId, attach } = await project();
  const hiring = await attach('hiring.md', `${SECRET}\n`);
  value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  const sent = await host.call('turns.send', { projectId, text: 'Write an editable brief', attachments: [hiring.id], settings, clientKey: 'a' });
  assert.equal(sent.ok, false);
  assert.match(sent.ok ? '' : sent.detail, /withdrawn/);
});

test('only an original is withdrawn, from the version seen; Retire still refuses it and Keep cannot undo it', async () => {
  const { host, projectId, attach } = await project();
  const hiring = await attach('hiring.md', 'x\n');
  assert.equal((await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'retired' })).ok, false);
  assert.equal((await host.call('material.lifecycle', { id: hiring.id, version: 2, state: 'withdrawn', lifecycle: 0 })).ok, false);
  const made = value(await host.call('turns.send', { projectId, text: 'Write an editable brief', attachments: [], settings, clientKey: 'a' }));
  await idle(host, made.threadId);
  const brief = (await host.call('material.list', { projectId })).find((m) => m.name === 'brief.md')!;
  const wrong = await host.call('material.lifecycle', { id: brief.id, version: brief.current, state: 'withdrawn', lifecycle: 0 });
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok ? '' : wrong.detail, /original/);

  value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  assert.equal((await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'kept', lifecycle: 1 })).ok, false);
  assert.ok((await host.call('work.now', { projectId })).withdrawn.some((d) => d.name === 'hiring.md'));
});

test('the person can restore it, and the record keeps both acts', async () => {
  const { host, projectId, attach } = await project();
  const hiring = await attach('hiring.md', 'x\n');
  value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  const back = value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'current', lifecycle: 1 }));
  assert.equal(back.hidden, false);
  assert.ok(back.withdrawals?.[0]?.restoredAt);
  assert.ok((await host.call('material.list', { projectId })).some((m) => m.name === 'hiring.md'));
  assert.deepEqual((await host.call('work.now', { projectId })).withdrawn, []);
});

test('every lifecycle change tells open views, and a refusal does not', async () => {
  const { host, projectId, attach } = await project();
  const hiring = await attach('hiring.md', 'x\n');
  const events: unknown[] = [];
  host.on((event) => events.push(event));
  const expected = { topic: 'material', id: projectId };
  value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  assert.deepEqual(events.splice(0), [expected]);
  assert.equal((await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'kept', lifecycle: 1 })).ok, false);
  assert.deepEqual(events.splice(0), []);
  value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'current', lifecycle: 1 }));
  assert.deepEqual(events.splice(0), [expected]);
});

test('withdrawing keeps a person\'s draft, and survives a restart', async () => {
  const { host, home, projectId, attach } = await project();
  const hiring = await attach('hiring.md', 'x\n');
  value(await host.call('drafts.put', { key: `material:${hiring.id}`, text: 'my unsaved words', clientKey: 'd' }));
  value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  assert.equal((await host.call('drafts.get', { key: `material:${hiring.id}` }))?.text, 'my unsaved words');
  host.close();
  const again = open(home, { harness: 'harness-pi' }).host;
  assert.ok((await again.call('work.now', { projectId })).withdrawn.some((d) => d.id === hiring.id));
});

test('withdrawal cannot hide an UNKNOWN, a running turn or a stopped one', () => {
  const entry = (name: string, extra = {}) => ({ id: name, name, class: 'original', hidden: true, current: 1, versions: [{ n: 1, by: 'person', at: 'a' }], withdrawals: [{ at: 'b', version: 1 }], ...extra }) as never;
  const summary = { id: 't', title: 'T', archived: false, running: true } as never;
  const turn = { effects: [{ target: 'hiring.md', outcome: 'UNKNOWN', detail: 'unknown' }], status: 'stopped', work: { steps: [] }, user: { at: 'a' } } as never;
  const now = workNow([{ summary, turns: [turn] }], [entry('hiring.md')], () => false);
  assert.deepEqual(now.needsYou.map((n) => n.kind), ['unknown']);
  assert.equal(now.running.length, 1);
  assert.deepEqual(now.withdrawn.map((d) => d.name), ['hiring.md']);
});

test('held documents need the person: release makes them current, Retire sets them aside', async () => {
  const { host, home, projectId } = await project();
  const store = new MaterialStore(home, {}, () => {});
  const held = store.create(projectId, 'notes (held).md', 'text/markdown', Buffer.from('notes'), 'working', 'agent', undefined, 'managed', { id: 'source', name: 'hiring.md' });
  const set = store.create(projectId, 'other (held).md', 'text/markdown', Buffer.from('other'), 'working', 'agent', undefined, 'managed', { id: 'source', name: 'hiring.md' });
  assert.equal(held.hidden, true);
  assert.deepEqual((await host.call('material.list', { projectId })).map((m) => m.name), []);
  const now = await host.call('work.now', { projectId });
  assert.deepEqual(now.needsYou.map((n) => [n.kind, n.materialId]).sort(), [['held', held.id], ['held', set.id]].sort());
  assert.deepEqual(now.needsYou.map((n) => n.version), [1, 1]);
  assert.deepEqual(now.retired, []);

  // Only an original is withdrawn: asking on a held document must not release it.
  assert.equal((await host.call('material.lifecycle', { id: held.id, version: 1, state: 'withdrawn', lifecycle: 0 })).ok, false);
  assert.equal(store.load(held.id)!.hidden, true);
  value(await host.call('material.lifecycle', { id: held.id, version: 1, state: 'current', lifecycle: 0 }));
  value(await host.call('material.lifecycle', { id: set.id, version: 1, state: 'retired', lifecycle: 0 }));
  assert.deepEqual((await host.call('material.list', { projectId })).map((m) => m.name), ['notes (held).md']);
  const later = await host.call('work.now', { projectId });
  assert.deepEqual(later.needsYou, []);
  assert.deepEqual(later.retired.map((d) => d.name), ['other (held).md']);
});

// ---- A turn in progress, on any harness, through the ToolHost -------------------------------------

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'withdrawal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const projected: string[] = [];
  const material = new MaterialStore(home, {}, (entry) => projected.push(entry.name));
  const projectId = 'project';
  const signal = new AbortController().signal;
  const original = (name: string, text: string) => material.create(projectId, name, 'text/markdown', Buffer.from(text), 'original', 'person');
  const working = (name: string, text: string) => material.create(projectId, name, 'text/markdown', Buffer.from(text), 'working', 'agent');
  const targets: Parameters<Gateway['write']>[0][] = [];
  let onRead = async () => {};
  let onWrite = async () => {};
  let onProgress = async () => {};
  const gateway: Gateway = {
    conditionalWrites: true,
    read: syntheticMaterialReader(home, material, projectId, { onRead: () => onRead() }),
    async write(target, effect, perform) {
      targets.push(target);
      try {
        await onWrite();
        const result = await perform();
        if (result === 'stopped') return undefined;
        effect.outcome = 'DONE';
        return result;
      } catch (error) { effect.outcome = 'REFUSED'; effect.detail = String(error); return undefined; }
    },
  };
  const withdraw = (id: string) => material.withdraw(id);
  async function run(work: (tools: ToolHost & Required<Pick<ToolHost, never>> & { writeIfVersion?: (n: string, b: string, base: { targetVersion: number | null; sources: { name: string; version: number }[] }, s: AbortSignal) => ReturnType<ToolHost['write']> }, request: TurnRequest) => Promise<void | TurnOutcome>, options: { history?: Turn[]; attachments?: ReturnType<typeof original>[]; notice?: string; tell?: (turn: Turn) => { text?: string; blocked?: boolean }; dispatched?: () => void } = {}) {
    const harness: HarnessV1 = {
      specificationVersion: 'v1', id: 'test', label: 'test',
      start(request, { tools }) {
        const outcome = work(tools as never, request).then((given): TurnOutcome => given ?? { status: 'done' as const, answer: `The agent says ${SECRET}.`, usage: { input: 0, output: 0 } });
        return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
      },
    };
    const turn: Turn = { id: 'turn', side: false, user: { text: 'Carry on.', attachments: [], at: '2026-10-31T00:00:00Z' }, work: { startedAt: '2026-10-31T00:00:00Z', harness: 'test', steps: [] }, effects: [], status: 'running' };
    await runHarnessTurn({ material, projectId, gateway, writeDelayMs: 0, signal, threadId: 'thread', harness,
      route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'test', label: 'test', credential: null },
      credential: async () => { throw new Error('No credential in this test'); }, history: options.history ?? [], resumed: false, notice: options.notice, progress: () => onProgress(),
      ...(options.tell ? { tell: () => options.tell!(turn) } : {}),
      ...(options.dispatched ? { dispatched: options.dispatched } : {}),
    }, turn, options.attachments ?? []);
    return turn;
  }
  const visible = () => material.list(projectId).map((e) => e.name);
  const hidden = () => material.list(projectId, true).filter((e) => e.hidden).map((e) => e.name);
  const text = (id: string) => Buffer.from(material.bytes(id, material.load(id)!.current)).toString();
  return { home, material, projectId, signal, original, working, withdraw, run, visible, hidden, text, targets, projected, onRead(fn: () => Promise<void>) { onRead = fn; }, onWrite(fn: () => Promise<void>) { onWrite = fn; }, onProgress(fn: () => Promise<void>) { onProgress = fn; } };
}

test('a structured tainted output stays held beside its leaf under a dotted directory', async (t) => {
  const s = setup(t);
  const source = s.original('source.md', 'Original source.');
  await s.run(async (tools) => {
    const read = await tools.read(source.name); assert.ok(read);
    s.withdraw(source.id);
    assert.equal((await tools.writeIfVersion!('v1.2/notes', 'Held work.', { targetVersion: null, sources: [{ name: source.name, version: read.version }] }, s.signal)).outcome, 'DONE');
  });
  assert.deepEqual(s.material.list(s.projectId, true).filter(entry => entry.held).map(entry => entry.name), ['v1.2/notes (held)']);
  assert.ok(s.material.load(source.id)?.hidden);
  assert.equal(s.material.list(s.projectId, true).find(entry => entry.held)?.projection, 'managed');
});

test('a stale structured target keeps the person version and places the revision beside its leaf', async (t) => {
  const s = setup(t);
  const target = s.material.create(s.projectId, 'release.notes/README', 'text/plain', Buffer.from('Version one.'), 'working', 'person', undefined, 'managed');
  await s.run(async (tools) => {
    const read = await tools.read(target.name); assert.ok(read);
    assert.ok((await s.material.save(target.id, 'Person version two.', 1)).ok);
    assert.equal((await tools.writeIfVersion!(target.name, 'Agent revision.', { targetVersion: 1, sources: [{ name: target.name, version: 1 }] }, s.signal)).outcome, 'DONE');
  });
  assert.equal(s.text(target.id), 'Person version two.');
  const beside = s.material.list(s.projectId).find(entry => entry.id !== target.id);
  assert.equal(beside?.name, 'release.notes/README (revision of v1)');
  assert.equal(s.text(beside!.id), 'Agent revision.');
});

test('a held structured output allocates around a case alias without replacing it', async (t) => {
  const s = setup(t);
  const source = s.original('source.md', 'Source.');
  const occupied = s.material.create(s.projectId, 'r/X (HELD).md', 'text/markdown', Buffer.from('Existing.'), 'working', 'agent', undefined, 'managed');
  await s.run(async tools => {
    const read = await tools.read(source.name); assert.ok(read);
    s.withdraw(source.id);
    const result = await tools.writeIfVersion!('r/x.md', 'Held body.', { targetVersion: null, sources: [{ name: source.name, version: read.version }] }, s.signal);
    assert.equal(result.outcome, 'DONE');
  });
  const held = s.material.list(s.projectId, true).find(entry => entry.held);
  assert.equal(held?.name, 'r/x (held 2).md');
  assert.equal(s.text(held!.id), 'Held body.');
  assert.equal(s.text(occupied.id), 'Existing.');
});

test('a stale structured revision allocates around existing and case-alias revisions', async (t) => {
  const s = setup(t);
  const target = s.material.create(s.projectId, 'r/x.md', 'text/markdown', Buffer.from('Version one.'), 'working', 'agent', undefined, 'managed');
  const occupied = s.material.create(s.projectId, 'r/X (REVISION OF V1).md', 'text/markdown', Buffer.from('Earlier revision.'), 'working', 'agent', undefined, 'managed');
  const turn = await s.run(async tools => {
    assert.ok(await tools.read(target.name));
    assert.ok((await s.material.save(target.id, 'Person version two.', 1)).ok);
    assert.equal((await tools.writeIfVersion!(target.name, 'New agent revision.', { targetVersion: 1, sources: [{ name: target.name, version: 1 }] }, s.signal)).outcome, 'DONE');
  });
  const beside = s.material.list(s.projectId).find(entry => entry.id !== target.id && entry.id !== occupied.id);
  assert.equal(beside?.name, 'r/x (revision of v1, 2).md');
  assert.equal(s.text(beside!.id), 'New agent revision.');
  assert.equal(s.text(occupied.id), 'Earlier revision.');
  assert.equal(s.text(target.id), 'Person version two.');
  assert.ok(turn.work.steps.some(step => step.label.includes(beside!.name)));
});

for (const name of ['r/' + 'x'.repeat(480) + '.md', 'r/'.repeat(248) + 'x.md', 'r/' + '😀'.repeat(240) + '.md']) test('a qualified revision retains work within the path limit: ' + name.length + ' / ' + Buffer.byteLength(name), async (t) => {
  const s = setup(t);
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('Version one.'), 'working', 'agent', undefined, 'managed');
  await s.run(async tools => {
    assert.ok(await tools.read(target.name));
    assert.ok((await s.material.save(target.id, 'Person version two.', 1)).ok);
    assert.equal((await tools.writeIfVersion!(target.name, 'Long-name revision.', { targetVersion: 1, sources: [{ name, version: 1 }] }, s.signal)).outcome, 'DONE');
  });
  const beside = s.material.list(s.projectId).find(entry => entry.id !== target.id);
  assert.ok(beside);
  assert.ok(beside.name.length <= 500);
  assert.equal(s.text(beside.id), 'Long-name revision.');
  assert.equal(s.text(target.id), 'Person version two.');
});

test('a failed beside write never claims that the revision was kept', async (t) => {
  const s = setup(t);
  const target = s.material.create(s.projectId, 'r/x.md', 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  s.onWrite(async () => { throw new Error('Simulated dispatch failure.'); });
  const turn = await s.run(async tools => {
    assert.ok(await tools.read(target.name));
    assert.ok((await s.material.save(target.id, 'Person second.', 1)).ok);
    assert.equal((await tools.writeIfVersion!(target.name, 'Uncommitted revision.', { targetVersion: 1, sources: [{ name: target.name, version: 1 }] }, s.signal)).outcome, 'REFUSED');
  });
  assert.equal(s.material.list(s.projectId).length, 1);
  assert.equal(turn.work.steps.some(step => /revision was kept/.test(step.label)), false);
  assert.equal(s.text(target.id), 'Person second.');
});

test('a stale target is attempted only once even when another free revision name exists', async (t) => {
  const s = setup(t);
  const target = s.material.create(s.projectId, 'r/x.md', 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  const results: string[] = [];
  await s.run(async tools => {
    assert.ok(await tools.read(target.name));
    assert.ok((await s.material.save(target.id, 'Person second.', 1)).ok);
    for (let i = 0; i < 2; i++) results.push((await tools.writeIfVersion!(target.name, 'Agent revision.', { targetVersion: 1, sources: [{ name: target.name, version: 1 }] }, s.signal)).outcome);
  });
  assert.deepEqual(results, ['DONE', 'REFUSED']);
  assert.equal(s.targets.length, 1);
  assert.equal(s.material.list(s.projectId).length, 2);
});

test('a tainted ordinary write with a directory is refused without throwing or proposing', async (t) => {
  const s = setup(t);
  const source = s.original('source.md', 'Source.');
  s.material.create(s.projectId, 'r/a.md', 'text/markdown', Buffer.from('Existing.'), 'working', 'agent', undefined, 'managed');
  let result = '';
  const turn = await s.run(async tools => {
    assert.ok(await tools.read(source.name));
    s.withdraw(source.id);
    result = (await tools.write('R/x.md', 'Not a flat ordinary write.', s.signal)).outcome;
  });
  assert.equal(result, 'REFUSED');
  assert.equal(turn.status, 'refused');
  assert.equal(turn.failure, undefined);
  assert.equal(s.targets.length, 0);
});

test('a turn neither lists nor reads a withdrawn original, and an attachment withdrawn before it starts is dropped', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  s.withdraw(hiring.id);
  let names: string[] = [], read: unknown = 'unset', attached: string[] = ['unset'];
  await s.run(async (tools, request) => {
    names = (await tools.list()).map((f) => f.name);
    read = await tools.read('hiring.md');
    attached = request.attachments;
  }, { attachments: [hiring] });
  assert.deepEqual(names, []);
  assert.equal(read, null);
  assert.deepEqual(attached, []);
});

test('the next turn is told by the host in the turn text', async (t) => {
  const s = setup(t);
  let text = '';
  await s.run(async (_tools, request) => { text = request.text; }, { notice: 'hiring.md was withdrawn.' });
  assert.match(text, /^hiring\.md was withdrawn\.\n\nCarry on\.$/);
});

test('withdrawn mid-turn after it was read: every later write is held out of reach, and none is lost', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const notes = s.working('notes.md', 'before');
  const turn = await s.run(async (tools) => {
    await tools.read('hiring.md');
    await tools.read('notes.md');
    s.withdraw(hiring.id);
    assert.equal((await tools.write('notes.md', `after ${SECRET}`, s.signal)).outcome, 'DONE');
    assert.equal((await tools.write('brief.md', 'a brief', s.signal)).outcome, 'DONE');
  });
  assert.equal(turn.status, 'done');
  // The visible document is untouched; the work is kept, hidden, naming why.
  assert.equal(s.text(notes.id), 'before');
  assert.deepEqual(s.visible(), ['notes.md']);
  assert.deepEqual(s.hidden().sort(), ['brief (held).md', 'hiring.md', 'notes (held).md']);
  const held = s.material.list(s.projectId, true).find((e) => e.name === 'notes (held).md')!;
  assert.equal(s.text(held.id), `after ${SECRET}`);
  assert.deepEqual(held.held, { id: hiring.id, name: 'hiring.md' });
  assert.ok(s.targets.every((target) => target.held?.id === hiring.id && !target.sourceVersions?.some((v) => v.id === hiring.id)));
  // Held work is not written into the person's folder either.
  assert.ok(!s.projected.some((name) => name.includes('(held)')));
  assert.match(turn.answer!.text, /hiring\.md was withdrawn while this turn worked/);
  assert.match(turn.answer!.text, /notes \(held\)\.md/);
  assert.equal(turn.withheld, true);
});

test('native imports, conditional on the staged versions, are held the same way', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  s.working('notes.md', 'before');
  const turn = await s.run(async (tools) => {
    const sources = [];
    for (const name of ['hiring.md', 'notes.md']) { const f = (await tools.read(name))!; sources.push({ name, version: f.version }); }
    s.withdraw(hiring.id);
    assert.equal((await tools.writeIfVersion!('notes.md', 'revised', { targetVersion: 1, sources }, s.signal)).outcome, 'DONE');
    assert.equal((await tools.writeIfVersion!('brief.md', 'new', { targetVersion: null, sources }, s.signal)).outcome, 'DONE');
  });
  assert.equal(turn.status, 'done');
  assert.deepEqual(s.visible(), ['notes.md']);
  assert.deepEqual(s.hidden().sort(), ['brief (held).md', 'hiring.md', 'notes (held).md']);
});

test('a write that never read the withdrawn original lands as usual', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const sales = s.original('sales.md', 'Marlin');
  const turn = await s.run(async (tools) => {
    await tools.read('sales.md');
    s.withdraw(hiring.id);
    assert.equal((await tools.write('brief.md', 'from sales', s.signal)).outcome, 'DONE');
  });
  assert.deepEqual(s.visible().sort(), ['brief.md', 'sales.md']);
  assert.equal(turn.withheld, undefined);
  assert.equal(s.material.load(sales.id)!.hidden, false);
});

test('a person\'s Save mid-turn on a held target stands', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const notes = s.working('notes.md', 'before');
  await s.run(async (tools) => {
    await tools.read('hiring.md');
    await tools.read('notes.md');
    s.withdraw(hiring.id);
    assert.equal((await s.material.save(notes.id, 'person', 1)).ok, true);
    assert.equal((await tools.write('notes.md', 'agent', s.signal)).outcome, 'DONE');
  });
  assert.equal(s.text(notes.id), 'person');
  assert.equal(s.material.load(notes.id)!.versions.length, 2);
});

test('the answer of a turn that had the withdrawn text is not replayed to later turns', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const first = await s.run(async (tools) => { await tools.read('hiring.md'); s.withdraw(hiring.id); });
  assert.equal(first.withheld, true);
  let history: TurnRequest['history'] = [];
  await s.run(async (_tools, request) => { history = request.history; }, { history: [first] });
  assert.ok(!JSON.stringify(history).includes('Kestrel'));
  assert.deepEqual(history.map((h) => h.role), ['user']);
});

test('a held write\'s custody survives normalisation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'withdrawal-custody-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(home, 'threads'));
  writeFileSync(join(home, 'threads', 'thread.json'), JSON.stringify({ summary: { id: 'thread', projectId: 'project' } }));
  const target = { name: 'notes (held).md', document: 'doc', body: 'x', baseVersion: null, sourceVersions: [], managed: true as const, held: { id: 'source', name: 'hiring.md' } };
  await retainOriginalWrite(home, 'thread', 'run', 'turn', 'project', target);
  assert.deepEqual((await originalWrite(home, 'thread', 'run', 'turn', 'project', target.name))?.target.held, target.held);
  assert.ok(readFileSync(join(home, 'threads', 'thread.json'), 'utf8').includes('hiring.md'));
});

// ---- The first cold review ------------------------------------------------------------------------

test('a turn that finished before the withdrawal is not replayed either', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const first = await s.run(async (tools) => { await tools.read('hiring.md'); });
  assert.equal(first.withheld, undefined);
  assert.deepEqual(first.reads?.map((r) => [r.id, r.version, r.withdrawals]), [[hiring.id, 1, 0]]);
  s.withdraw(hiring.id);
  let history: TurnRequest['history'] = [];
  await s.run(async (_tools, request) => { history = request.history; }, { history: [first] });
  assert.deepEqual(history.map((h) => h.role), ['user']);
  // Restored, the source is in reach again for a fresh read; what came from the old version stays out.
  s.material.restore(hiring.id);
  await s.run(async (_tools, request) => { history = request.history; }, { history: [first] });
  assert.deepEqual(history.map((h) => h.role), ['user']);
});

test('a turn from before reads were recorded is judged by its read steps', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const first = await s.run(async (tools) => { await tools.read('hiring.md'); });
  delete first.reads;
  s.withdraw(hiring.id);
  let history: TurnRequest['history'] = [];
  await s.run(async (_tools, request) => { history = request.history; }, { history: [first] });
  assert.deepEqual(history.map((h) => h.role), ['user']);
});

test('withdrawn and restored while the turn worked still counts', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const turn = await s.run(async (tools) => {
    await tools.read('hiring.md');
    s.withdraw(hiring.id);
    s.material.restore(hiring.id);
    assert.equal((await tools.write('brief.md', 'a brief', s.signal)).outcome, 'DONE');
  });
  assert.deepEqual(s.hidden(), ['brief (held).md']);
  assert.equal(turn.withheld, true);
});

test('withdrawn while a read is being recorded: the text is not returned, and the turn counts as having it', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  s.onRead(async () => { s.withdraw(hiring.id); });
  let read: unknown = 'unset';
  const turn = await s.run(async (tools) => { read = await tools.read('hiring.md'); });
  assert.equal(read, null);
  assert.equal(turn.withheld, true);
});

test('a stale lifecycle request cannot undo a newer decision', async () => {
  const { host, projectId, attach } = await project();
  const hiring = await attach('hiring.md', 'x\n');
  assert.equal((await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn' })).ok, false, 'withdrawing names what was seen');
  const withdrawn = value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  const seen = (await host.call('work.now', { projectId })).withdrawn[0]!;
  assert.equal(seen.lifecycle, withdrawn.lifecycle);
  const restored = value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'current', lifecycle: seen.lifecycle }));
  const stale = await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: 0 });
  assert.equal(stale.ok, false);
  value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: restored.lifecycle }));
  const staleRestore = await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'current', lifecycle: restored.lifecycle });
  assert.equal(staleRestore.ok, false);
  assert.equal((await host.call('work.now', { projectId })).withdrawn.length, 1);
});

test('a person\'s Save keeps a held document held, and its retirement keeps the guards', async () => {
  const { host, home, projectId } = await project();
  const projected: string[] = [];
  const store = new MaterialStore(home, {}, (entry) => projected.push(entry.name));
  const held = store.create(projectId, 'notes (held).md', 'text/markdown', Buffer.from('notes'), 'working', 'agent', undefined, 'managed', { id: 'source', name: 'hiring.md' });
  const saved = await store.save(held.id, 'my edit', 1);
  assert.equal(saved.ok && saved.value.hidden, true);
  assert.deepEqual(projected, []);
  assert.deepEqual((await host.call('material.list', { projectId })).map((m) => m.name), []);
  const edited = store.load(held.id)!;
  const retired = await host.call('material.lifecycle', { id: held.id, version: edited.current, state: 'retired', lifecycle: edited.lifecycle ?? 0 });
  assert.equal(retired.ok, false);
  assert.ok((await host.call('work.now', { projectId })).needsYou.some((n) => n.kind === 'held'));

  const draft = store.create(projectId, 'draft (held).md', 'text/markdown', Buffer.from('d'), 'working', 'agent', undefined, 'managed', { id: 'source', name: 'hiring.md' });
  value(await host.call('drafts.put', { key: `edit:${draft.id}`, text: 'unsaved', clientKey: 'd' }));
  assert.equal((await host.call('material.lifecycle', { id: draft.id, version: 1, state: 'retired', lifecycle: 0 })).ok, false);
});

async function crashed(point: string) {
  const home = freshHome();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-withdrawal.ts'), home], {
    env: { ...process.env, BACKBONE_HARNESS: 'harness-pi', BACKBONE_CRASH_AT: point }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b));
  await new Promise((r) => child.on('exit', r));
  const [{ projectId, sourceId }, { threadId }] = out.trim().split('\n').map((line) => JSON.parse(line)) as [{ projectId: string; sourceId: string }, { threadId: string }];
  return { home, projectId, sourceId, threadId, store: new MaterialStore(home, {}, () => {}) };
}
const settle = async (host: ReturnType<typeof open>['host'], threadId: string) => { await new Promise((r) => setTimeout(r, 7000)); return idle(host, threadId); };

test('killed after the write landed, then withdrawn: that document was ordinary earlier work, and the turn is withheld', async () => {
  const c = await crashed('write.recorded');
  c.store.withdraw(c.sourceId);
  const { host } = open(c.home, { harness: 'harness-pi' });
  const thread = await settle(host, c.threadId);
  const turn = thread.turns.at(-1)!;
  assert.equal(turn.withheld, true);
  assert.deepEqual((await host.call('material.list', { projectId: c.projectId })).map((m) => m.name), ['brief.md']);
  assert.deepEqual((await host.call('work.now', { projectId: c.projectId })).withdrawn[0]!.mayCarry, ['brief.md']);
  assert.match(turn.answer!.text, /hiring\.md was withdrawn/);
});

test('killed before dispatch, then withdrawn and restored: recovery lands the write held', async () => {
  const c = await crashed('write.claimed');
  c.store.withdraw(c.sourceId);
  c.store.restore(c.sourceId);
  const { host } = open(c.home, { harness: 'harness-pi' });
  const thread = await settle(host, c.threadId);
  assert.equal(thread.turns.at(-1)!.withheld, true);
  assert.deepEqual((await host.call('material.list', { projectId: c.projectId })).map((m) => m.name), ['hiring.md']);
  const held = (await host.call('material.list', { projectId: c.projectId, includeHidden: true })).find((m) => m.name === 'brief.md');
  assert.ok(held?.held);
});

test('the scripted route reads neither withdrawn nor held material', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const held = s.material.create(s.projectId, 'x (held).md', 'text/markdown', Buffer.from('h'), 'working', 'agent', undefined, undefined, { id: hiring.id, name: 'hiring.md' });
  s.withdraw(hiring.id);
  assert.deepEqual(s.material.available(s.projectId).map((e) => e.id), []);
  assert.ok(held.hidden);
});

// ---- The second cold review -----------------------------------------------------------------------

const folder = async (host: ReturnType<typeof open>['host'], projectId: string, name: string) => value(await host.call('terminal.run', { projectId, command: `cat ${name}` }));

test('a withdrawn original leaves the project folder and comes back on restore', async () => {
  const { host, projectId, attach } = await project();
  const hiring = await attach('hiring.md', `${SECRET}\n`);
  assert.match((await folder(host, projectId, 'hiring.md')).output, /Kestrel/);
  const out = value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  assert.notEqual((await folder(host, projectId, 'hiring.md')).code, 0);
  assert.ok(!(await host.call('files.list', { projectId })).some((f) => f.path === 'hiring.md'));
  assert.equal(value(await host.call('material.read', { id: hiring.id, version: 1 })).text, `${SECRET}\n`);
  value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'current', lifecycle: out.lifecycle }));
  assert.match((await folder(host, projectId, 'hiring.md')).output, /Kestrel/);
});

test('a person\'s edit to the folder copy is moved aside with it and returned, not lost', async () => {
  const { host, projectId, attach } = await project();
  const hiring = await attach('hiring.md', 'x\n');
  value(await host.call('terminal.run', { projectId, command: 'chmod u+w hiring.md && echo mine > hiring.md' }));
  const out = value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  value(await host.call('material.lifecycle', { id: hiring.id, version: 1, state: 'current', lifecycle: out.lifecycle }));
  assert.equal((await folder(host, projectId, 'hiring.md')).output, 'mine\n');
});

test('a kill between the withdrawal and the folder move is finished at the next start', async () => {
  const { host, home, projectId, attach } = await project();
  const hiring = await attach('hiring.md', `${SECRET}\n`);
  host.close();
  const meta = join(home, 'material', hiring.id, 'meta.json');
  writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, 'utf8')), hidden: true, withdrawals: [{ at: new Date().toISOString(), version: 1 }], lifecycle: 1, projecting: 'out', folderSha: sha256(Buffer.from(`${SECRET}\n`)) }));
  const again = open(home, { harness: 'harness-pi' }).host;
  assert.notEqual((await folder(again, projectId, 'hiring.md')).code, 0);
  assert.equal(JSON.parse(readFileSync(meta, 'utf8')).projecting, undefined);
});

test('holding a recovered document takes it out of the folder too, and release returns it', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'withdrawal-folder-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'brief.md');
  const material = new MaterialStore(home, {}, (_entry, bytes) => writeFileSync(path, bytes), () => path);
  const entry = material.create('project', 'brief.md', 'text/markdown', Buffer.from('b'), 'working', 'agent');
  assert.ok(existsSync(path));
  material.mark(entry.id, { hidden: true, held: { id: 's', name: 'hiring.md' } });
  assert.ok(!existsSync(path));
  material.mark(entry.id, { hidden: false, held: undefined });
  assert.equal(readFileSync(path, 'utf8'), 'b');
});

test('a held document cannot be attached', async () => {
  const { host, home, projectId } = await project();
  const held = new MaterialStore(home, {}, () => {}).create(projectId, 'n.md', 'text/markdown', Buffer.from('n'), 'working', 'agent', undefined, 'managed', { id: 'source', name: 'hiring.md' });
  const sent = await host.call('turns.send', { projectId, text: 'Write an editable brief', attachments: [held.id], settings, clientKey: 'a' });
  assert.equal(sent.ok, false);
  assert.match(sent.ok ? '' : sent.detail, /held/);
});

test('every lifecycle request after the first names what was seen, so a stale one cannot undo a retire', async () => {
  const { host, home, projectId } = await project();
  const store = new MaterialStore(home, {}, () => {});
  const doc = store.create(projectId, 'n.md', 'text/markdown', Buffer.from('n'), 'working', 'agent');
  const retired = value(await host.call('material.lifecycle', { id: doc.id, version: 1, state: 'retired' }));
  assert.equal((await host.call('material.lifecycle', { id: doc.id, version: 1, state: 'current' })).ok, false);
  assert.equal((await host.call('material.lifecycle', { id: doc.id, version: 1, state: 'current', lifecycle: 0 })).ok, false);
  value(await host.call('material.lifecycle', { id: doc.id, version: 1, state: 'current', lifecycle: retired.lifecycle }));
});

test('a turn given another as history inherits what it read, durably and transitively', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const a = await s.run(async (tools) => { await tools.read('hiring.md'); });
  const b = await s.run(async () => {}, { history: [a] });
  assert.deepEqual(b.reads?.map((r) => r.id), [hiring.id]);
  assert.equal(b.reads?.[0]?.inherited, true);
  s.withdraw(hiring.id);
  let history: TurnRequest['history'] = [];
  const c = await s.run(async (_tools, request) => { history = request.history; }, { history: [a, b] });
  assert.deepEqual(history.map((h) => h.role), ['user', 'user']);
  assert.deepEqual(c.reads, [], 'nothing excluded is inherited');
});

test('a turn from before reads were recorded that follows an excluded one is excluded too', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const a = await s.run(async (tools) => { await tools.read('hiring.md'); });
  const b = await s.run(async () => {}, { history: [a] });
  delete a.reads; delete b.reads;
  s.withdraw(hiring.id);
  let history: TurnRequest['history'] = [];
  await s.run(async (_tools, request) => { history = request.history; }, { history: [a, b] });
  assert.deepEqual(history.map((h) => h.role), ['user', 'user']);
});

test('withdrawn and restored while a read is recorded: the text is still not delivered', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  s.onRead(async () => { s.withdraw(hiring.id); s.material.restore(hiring.id); });
  let read: unknown = 'unset';
  await s.run(async (tools) => { read = await tools.read('hiring.md'); });
  assert.equal(read, null);
});

test('withdrawn and restored while a write waits for the lock: a new document lands held, a revision is refused', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const notes = s.working('notes.md', 'before');
  let flipped = false;
  s.onWrite(async () => { if (!flipped) { flipped = true; s.withdraw(hiring.id); s.material.restore(hiring.id); } });
  const results: string[] = [];
  const turn = await s.run(async (tools) => {
    await tools.read('hiring.md');
    results.push((await tools.write('brief.md', 'new', s.signal)).outcome);
  });
  assert.deepEqual(results, ['DONE']);
  assert.ok(s.material.list(s.projectId, true).find((e) => e.name === 'brief.md')?.held);
  assert.match(turn.answer!.text, /brief\.md/);

  const s2 = setup(t);
  const source = s2.original('hiring.md', SECRET);
  const draft = s2.working('notes.md', 'before');
  let once = false;
  s2.onWrite(async () => { if (!once) { once = true; s2.withdraw(source.id); s2.material.restore(source.id); } });
  await s2.run(async (tools) => {
    await tools.read('hiring.md');
    await tools.read('notes.md');
    assert.notEqual((await tools.write('notes.md', 'after', s2.signal)).outcome, 'DONE');
  });
  assert.equal(s2.text(draft.id), 'before');
  assert.ok(notes);
});

test('recovery holds only what this turn wrote after the withdrawal, and asks about what it cannot hide', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const early = s.working('early.md', 'e');
  s.withdraw(hiring.id);
  const late = s.working('late.md', 'l');
  const edited = s.working('edited.md', 'v1');
  await s.material.save(edited.id, 'person', 1);
  const turn = { reads: [{ id: hiring.id, name: 'hiring.md', version: 1, withdrawals: 0 }], effects: [], answer: { text: 'x', files: [] } } as unknown as Turn;
  // `early` was stamped before the withdrawal; make that certain across a same-millisecond run.
  const meta = join(s.home, 'material', early.id, 'meta.json');
  const stored = JSON.parse(readFileSync(meta, 'utf8'));
  stored.versions[0].at = '2000-01-01T00:00:00.000Z';
  writeFileSync(meta, JSON.stringify(stored));
  const link = (e: { id: string; name: string }, version: number) => ({ materialId: e.id, name: e.name, version });
  holdRecovered(turn, s.material, [link(early, 1), link(late, 1), link(edited, 1)], () => false);
  assert.equal(s.material.load(early.id)!.hidden, false);
  assert.ok(s.material.load(late.id)!.held);
  assert.equal(s.material.load(edited.id)!.hidden, false, 'the person\'s version stands');
  assert.ok(s.material.load(edited.id)!.unsure, 'a later version may still carry it');
  assert.equal(s.material.load(early.id)!.unsure, undefined);
  assert.equal(turn.withheld, true);

  const open2 = s.working('open.md', 'o');
  const asked = { reads: turn.reads, effects: [], answer: { text: 'x', files: [] } } as unknown as Turn;
  holdRecovered(asked, s.material, [link(open2, 1)], () => true);
  assert.equal(s.material.load(open2.id)!.hidden, false);
  const summary = { id: 't', title: 'T', archived: false, running: false } as never;
  const now = workNow([{ summary, turns: [] }], [s.material.load(open2.id)!], () => false);
  assert.deepEqual(now.needsYou.map((n) => [n.kind, n.materialId]), [['unsure', open2.id]]);
  // A Save settles nothing: the new version may still carry it.
  await s.material.save(open2.id, 'more', 1);
  assert.ok(s.material.load(open2.id)!.unsure);
});

// ---- The third cold review ------------------------------------------------------------------------

test('Keep is the person\'s decision on an unsure document, and Retire cannot hide one', async () => {
  const { host, home, projectId } = await project();
  const store = new MaterialStore(home, {}, () => {});
  const doc = store.create(projectId, 'n.md', 'text/markdown', Buffer.from('n'), 'working', 'agent');
  const marked = store.mark(doc.id, { hidden: false, unsure: { id: 'source', name: 'hiring.md' } });
  const now = await host.call('work.now', { projectId });
  assert.deepEqual(now.needsYou.map((n) => [n.kind, n.lifecycle]), [['unsure', marked.lifecycle]]);
  assert.deepEqual(now.temporary, []);
  assert.equal((await host.call('material.lifecycle', { id: doc.id, version: 1, state: 'retired', lifecycle: marked.lifecycle })).ok, false);
  const kept = value(await host.call('material.lifecycle', { id: doc.id, version: 1, state: 'kept', lifecycle: marked.lifecycle }));
  assert.equal(kept.unsure, undefined);
  assert.deepEqual((await host.call('work.now', { projectId })).needsYou, []);
});

test('history is built after the last wait before the harness starts', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const a = await s.run(async (tools) => { await tools.read('hiring.md'); });
  let once = false;
  s.onProgress(async () => { if (!once) { once = true; s.withdraw(hiring.id); } });
  let history: TurnRequest['history'] = [];
  await s.run(async (_tools, request) => { history = request.history; }, { history: [a] });
  assert.deepEqual(history.map((h) => h.role), ['user']);
});

test('history withdrawn while the engine starts never reaches the model input it sends', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const a = await s.run(async (tools) => { await tools.read('hiring.md'); });
  let sent: TurnRequest['history'] = [];
  await s.run(async (_tools, request) => {
    // Staging and connecting: the engine has the request, and builds the input only once ready.
    await new Promise((r) => setTimeout(r, 1));
    s.withdraw(hiring.id);
    sent = request.recall?.().history ?? request.history;
  }, { history: [a] });
  assert.deepEqual(sent.map((h) => h.role), ['user']);
  assert.ok(!JSON.stringify(sent).includes('Kestrel'));
});

/** An engine that honours the send-time gate: it builds its input from recall, checks, and sends nothing when refused. */
const gated = (sent: { text?: string }, answer: string) => async (_tools: unknown, request: TurnRequest): Promise<TurnOutcome> => {
  const given = request.recall?.() ?? {};
  const allowed = request.stillAllowed?.() ?? true;
  if (allowed !== true) return { status: 'interrupted', answer: '', error: allowed, usage: { input: 0, output: 0 } };
  sent.text = [...(given.history ?? request.history).map((h) => h.text), request.text].join('\n');
  return { status: 'done', answer, usage: { input: 0, output: 0 } };
};

test('a told report whose source is withdrawn while the engine starts is not sent: the turn ends saying why', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const sent: { text?: string } = {};
  const engine = gated(sent, 'Done.');
  const turn = await s.run(async (tools, request) => {
    await new Promise((r) => setTimeout(r, 1));
    s.withdraw(hiring.id);
    return engine(tools, request);
  }, { tell: (turn) => { turn.reads!.push({ id: hiring.id, name: 'hiring.md', version: 1, withdrawals: 0, inherited: true, told: true }); return { text: `Report from the child: ${SECRET}` }; } });
  assert.equal(sent.text, undefined, 'nothing was sent');
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer!.text, /withdrawn/);
  assert.match(turn.answer!.text, /nothing was sent/i);
});

// The receipt of the route a selected turn ran on (host.ts) is written from this hook: a turn the gate stopped claims none.
test('a turn the send-time gate stops reports no dispatch; one the gate lets through reports it once per request', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  let stopped = 0, passed = 0;
  const sent: { text?: string } = {};
  const engine = gated(sent, 'Done.');
  const turn = await s.run(async (tools, request) => {
    await new Promise((r) => setTimeout(r, 1));
    s.withdraw(hiring.id);
    return engine(tools, request);
  }, { dispatched: () => stopped++, tell: (turn) => { turn.reads!.push({ id: hiring.id, name: 'hiring.md', version: 1, withdrawals: 0, inherited: true, told: true }); return { text: `Report from the child: ${SECRET}` }; } });
  assert.equal(sent.text, undefined, 'nothing was sent');
  assert.equal(turn.status, 'stopped');
  assert.equal(stopped, 0, 'no request left, so nothing may claim one did');
  const clean = await s.run(gated({}, 'Done.'), { dispatched: () => passed++ });
  assert.equal(clean.status, 'done');
  assert.equal(passed, 1);
});

test('an inherited answer dropped as the input is built leaves a clean answer clean', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const a = await s.run(async (tools) => { await tools.read('hiring.md'); });
  const sent: { text?: string } = {};
  const engine = gated(sent, '4');
  const b = await s.run(async (tools, request) => {
    await new Promise((r) => setTimeout(r, 1));
    s.withdraw(hiring.id);
    return engine(tools, request);
  }, { history: [a] });
  assert.ok(!sent.text?.includes('Kestrel'), 'the withdrawn answer was not sent');
  assert.equal(b.status, 'done');
  assert.ok(!b.withheld, 'what was sent carried nothing withdrawn');
  assert.equal(b.answer!.text, '4');
  let history: TurnRequest['history'] = [];
  await s.run(async (_tools, request) => { history = request.history; }, { history: [a, b] });
  assert.ok(history.some((h) => h.text === '4'), 'and later turns are given it');
});

test('a turn with no read set counts as unknown: out of replay once anything was withdrawn, and so is what inherits it', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const old = await s.run(async () => {});
  delete old.reads;
  let history: TurnRequest['history'] = [];
  await s.run(async (_tools, request) => { history = request.history; }, { history: [old] });
  assert.deepEqual(history.map((h) => h.role), ['user', 'assistant'], 'nothing has been withdrawn yet');
  const next = await s.run(async () => {}, { history: [old] });
  assert.equal(next.unknownSources, true);
  s.withdraw(hiring.id);
  s.material.restore(hiring.id);
  await s.run(async (_tools, request) => { history = request.history; }, { history: [old, next] });
  assert.deepEqual(history.map((h) => h.role), ['user', 'user']);
});

function folderStore(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'withdrawal-digest-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'hiring.md');
  const open = () => new MaterialStore(home, {}, (_e, bytes) => writeFileSync(path, bytes), () => path);
  const material = open();
  const entry = material.create('project', 'hiring.md', 'text/markdown', Buffer.from('ours'), 'original', 'person');
  return { material, entry, path, open, meta: join(home, 'material', entry.id, 'meta.json') };
}

test('a kill before the folder move cannot move a different file a person put there', (t) => {
  const f = folderStore(t);
  writeFileSync(f.meta, JSON.stringify({ ...JSON.parse(readFileSync(f.meta, 'utf8')), hidden: true, projecting: 'out', folderSha: sha256(Buffer.from('ours')) }));
  writeFileSync(f.path, 'a new file of theirs');
  const again = f.open();
  again.settleProjections();
  assert.equal(readFileSync(f.path, 'utf8'), 'a new file of theirs');
  assert.equal(again.load(f.entry.id)!.projecting, undefined);
  assert.equal(again.load(f.entry.id)!.folderConflict, true);
});

test('restore never overwrites a file now at that path, and says so', (t) => {
  const f = folderStore(t);
  f.material.withdraw(f.entry.id);
  writeFileSync(f.path, 'a new file of theirs');
  const back = f.material.restore(f.entry.id);
  assert.equal(readFileSync(f.path, 'utf8'), 'a new file of theirs');
  assert.equal(back.folderConflict, true);
  assert.deepEqual(workNow([], [back], () => false).needsYou.map((n) => n.kind), ['unsure']);
});

// ---- The last check of the repairs ----------------------------------------------------------------

test('a turn that inherited unknown sources counts as tainted by any withdrawal while it runs', async (t) => {
  const s = setup(t);
  const hiring = s.original('hiring.md', SECRET);
  const old = await s.run(async () => {});
  delete old.reads;
  const turn = await s.run(async (tools) => {
    s.withdraw(hiring.id);
    s.material.restore(hiring.id);
    assert.equal((await tools.write('brief.md', 'a brief', s.signal)).outcome, 'DONE');
  }, { history: [old] });
  assert.equal(turn.withheld, true);
  assert.ok(s.material.list(s.projectId, true).find((e) => e.name === 'brief (held).md')?.held);
});

test('a file swapped in just before the folder move goes back, and is put to the person', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'withdrawal-swap-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'hiring.md');
  const material = new MaterialStore(home, { beforeFolderMove: () => writeFileSync(path, 'swapped in') }, (_e, bytes) => writeFileSync(path, bytes), () => path);
  const entry = material.create('project', 'hiring.md', 'text/markdown', Buffer.from('ours'), 'original', 'person');
  const out = material.withdraw(entry.id);
  assert.equal(readFileSync(path, 'utf8'), 'swapped in');
  assert.equal(out.folderConflict, true);
});

test('classification that fails is kept for the next start and shown, not dropped', async (t) => {
  const s = setup(t);
  const doc = s.working('late.md', 'l');
  const link = { materialId: doc.id, name: doc.name, version: 1 };
  const turn = { reads: [], effects: [], answer: { text: 'x', files: [] } } as unknown as Turn;
  await classifyRecovered(turn, s.material, [link], () => false, async () => { throw new Error('the lock could not be taken'); });
  assert.deepEqual(turn.unclassified, [link]);
  const summary = { id: 't', title: 'T', archived: false, running: false } as never;
  const now = workNow([{ summary, turns: [{ ...turn, status: 'done', user: { at: 'a' }, work: { steps: [] } } as never] }], [doc], () => false);
  assert.deepEqual(now.needsYou.map((n) => [n.kind, n.threadId]), [['unsure', 't']]);
  await classifyRecovered(turn, s.material, turn.unclassified!, () => false, (run) => run());
  assert.equal(turn.unclassified, undefined);
});

test('a start retries classification a previous start could not finish', async () => {
  const c = await crashed('write.recorded');
  const first = open(c.home, { harness: 'harness-pi' });
  await settle(first.host, c.threadId);
  first.host.close();
  const brief = c.store.list(c.projectId, true).find((e) => e.name === 'brief.md')!;
  c.store.withdraw(c.sourceId);
  const meta = join(c.home, 'material', brief.id, 'meta.json');
  const stored = JSON.parse(readFileSync(meta, 'utf8'));
  stored.versions[0].at = '2099-01-01T00:00:00.000Z';
  writeFileSync(meta, JSON.stringify(stored));
  const threadPath = join(c.home, 'threads', `${c.threadId}.json`);
  const thread = JSON.parse(readFileSync(threadPath, 'utf8'));
  thread.turns.at(-1).unclassified = [{ materialId: brief.id, name: brief.name, version: 1 }];
  writeFileSync(threadPath, JSON.stringify(thread));
  const { host } = open(c.home, { harness: 'harness-pi' });
  await host.call('models.list', {});
  await host.call('threads.list', {});
  await pollUntil(async active => { while (active() && (!c.store.load(brief.id)!.held)) await new Promise((r) => setTimeout(r, 100)); }, "packages/platform/test/withdrawal.test.ts:975 polling state");
  assert.ok(c.store.load(brief.id)!.held);
  assert.equal(value(await host.call('threads.get', { id: c.threadId })).turns.at(-1)!.unclassified, undefined);
});
