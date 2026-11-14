import { syntheticMaterialReader } from './fixtures/synthetic-material-reader.ts';
// A native turn's finished pieces survive a kill, a failure or a changed source: they are kept on disk
// while the turn runs, and only recovery imports them, through the same checks as any write.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { EffectRecord, Turn } from '../src/api.ts';
import { recoveredStatus, runHarnessTurn, type Checkpoint } from '../src/composition/harness-turn.ts';
import { workNow } from '../src/composition/work-now.ts';
import type { HarnessV1, ToolHost, TurnOutcome } from '../src/ports/harness.ts';
import type { Gateway } from '../src/stub/harness.ts';
import { MaterialStore } from '../src/stub/material.ts';

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'checkpoints-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const projectId = 'project';
  const written: string[] = [];
  const proposed: Parameters<Gateway['write']>[0][] = [];
  let unknownOn = '';
  let commitUnknown = false;
  const gateway: Gateway = {
    conditionalWrites: true,
    read: syntheticMaterialReader(home, material, projectId),
    async write(target, effect, perform) {
      written.push(target.name); proposed.push(structuredClone(target));
      if (target.name === unknownOn) { effect.detail = `The write of ${target.name} is UNKNOWN.`; return undefined; }
      const result = await perform();
      if (result === 'stopped') return undefined;
      if (commitUnknown) { effect.outcome = 'UNKNOWN'; return undefined; }
      effect.outcome = 'DONE';
      return result;
    },
  };
  let saved: Checkpoint | null = null;
  let lastSaved: Checkpoint | null = null;
  const log: string[] = [];
  const checkpoints = { load: () => saved, save: async (c: Checkpoint) => { saved = c; lastSaved = structuredClone(c); }, clear: async () => { log.push('cleared'); saved = null; } };
  let current: Turn | undefined;
  const newTurn = (extra: Partial<Turn> = {}): Turn => ({ id: 'turn', side: false, user: { text: 'Carry on.', attachments: [], at: 'a' }, work: { startedAt: 'a', harness: 'test', steps: [] }, effects: [], status: 'running', ...extra });
  let started = 0;
  async function run(turn: Turn, work: (tools: ToolHost) => Promise<TurnOutcome['status']>, resumed = false) {
    const harness: HarnessV1 = {
      specificationVersion: 'v1', id: 'test', label: 'test',
      start(_request, { tools }) {
        started++;
        const outcome = work(tools).then((status) => ({ status, answer: 'Answer.', usage: { input: 0, output: 0 }, ...(status === 'failed' ? { error: 'it broke' } : {}) }));
        return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
      },
    };
    current = turn;
    await runHarnessTurn({ material, projectId, gateway, writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
      route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'test', label: 'test', credential: null },
      credential: async () => { throw new Error('No credential in this test'); }, history: [], resumed, checkpoints, progress() { log.push(`saved ${current!.status}`); },
    }, turn, []);
    return turn;
  }
  const source = (name = 'source.md') => material.create(projectId, name, 'text/markdown', Buffer.from('s'), 'working', 'agent');
  const read = (id: string, name: string, version = 1) => ({ id, name, version, withdrawals: 0 });
  const put = (c: Checkpoint) => { saved = c; };
  const names = () => material.list(projectId).map((e) => e.name);
  const hidden = () => material.list(projectId, true).filter((e) => e.hidden).map((e) => e.name);
  return { log, material, projectId, written, proposed, checkpoints, newTurn, run, source, read, put, names, hidden, commitUnknown() { commitUnknown = true; }, unknownOn(name: string) { unknownOn = name; }, get saved() { return saved; }, get lastSaved() { return lastSaved; }, get started() { return started; } };
}
const note = { name: 'note.md', body: 'finished\n', targetVersion: null };

test('recovery imports the finished pieces, starts no producer, and never calls the turn done', async (t) => {
  const s = setup(t);
  const src = s.source();
  s.put({ files: [note], sources: [{ name: 'source.md', version: 1 }] });
  const turn = await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')] }), async () => 'done', true);
  assert.equal(s.started, 0);
  assert.deepEqual(s.names(), ['source.md', 'note.md']);
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer!.text, /interrupted/);
  assert.match(turn.answer!.text, /note\.md/);
  assert.equal(s.saved, null);
});

test('a recovered piece reads as unsure: it came from an interrupted turn and may be incomplete', async (t) => {
  const s = setup(t);
  const src = s.source();
  s.put({ files: [note], sources: [{ name: 'source.md', version: 1 }] });
  await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')] }), async () => 'done', true);
  const entry = s.material.list(s.projectId).find((e) => e.name === 'note.md')!;
  assert.equal(entry.unsure?.interrupted, true);
  const now = workNow([], [entry], () => false);
  assert.deepEqual(now.needsYou.map((n) => n.kind), ['unsure']);
  assert.match(now.needsYou[0]!.detail, /interrupted/);
  assert.match(now.needsYou[0]!.detail, /incomplete/);
  assert.deepEqual(now.temporary, []);
});

test('a name with a recorded outcome is not written again, and a repeated recovery still marks it', async (t) => {
  const s = setup(t);
  const src = s.source();
  const other = s.material.create(s.projectId, 'other.md', 'text/markdown', Buffer.from('o'), 'working', 'agent');
  s.put({ files: [{ name: 'other.md', body: 'o', targetVersion: null }, { name: 'third.md', body: 't', targetVersion: null }], sources: [{ name: 'source.md', version: 1 }] });
  const effects: EffectRecord[] = [{ key: 'l', kind: 'write-working-copy', target: 'other.md', outcome: 'DONE' }];
  await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')], effects }), async () => 'done', true);
  assert.deepEqual(s.written, ['third.md']);
  assert.ok(s.material.load(other.id)!.unsure);
});

test('an UNKNOWN stops the import, proposes nothing after it, and is what the turn reports', async (t) => {
  const s = setup(t);
  const src = s.source();
  s.put({ files: [{ name: 'third.md', body: 't', targetVersion: null }], sources: [{ name: 'source.md', version: 1 }] });
  const effects: EffectRecord[] = [{ key: 'k', kind: 'write-working-copy', target: 'note.md', outcome: 'UNKNOWN', detail: 'The write of note.md is UNKNOWN.' }];
  const turn = await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')], effects }), async () => 'done', true);
  assert.deepEqual(s.written, []);
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer!.text, /note\.md is UNKNOWN/);
});

test('an UNKNOWN from the import itself stops the rest', async (t) => {
  const s = setup(t);
  const src = s.source();
  s.put({ files: [note, { name: 'third.md', body: 't', targetVersion: null }], sources: [{ name: 'source.md', version: 1 }] });
  s.unknownOn('note.md');
  const turn = await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')] }), async () => 'done', true);
  assert.deepEqual(s.written, ['note.md']);
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer!.text, /UNKNOWN/);
});

test('an empty checkpoint replaces the last one', async (t) => {
  const s = setup(t);
  s.source();
  const seen: (Checkpoint | null)[] = [];
  await s.run(s.newTurn(), async (tools) => {
    await tools.read('source.md');
    await tools.checkpoint!([note], [{ name: 'source.md', version: 1 }]);
    seen.push(s.saved);
    await tools.checkpoint!([], [{ name: 'source.md', version: 1 }]);
    seen.push(s.saved);
    return 'interrupted';
  });
  assert.ok(seen[0]);
  assert.equal(seen[1], null);
});

test('the stopped status is saved before the checkpoint goes, so a kill cannot turn it into done', async (t) => {
  const s = setup(t);
  const src = s.source();
  s.put({ files: [note], sources: [{ name: 'source.md', version: 1 }] });
  await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')] }), async () => 'done', true);
  assert.deepEqual(s.log.slice(-2), ['saved stopped', 'cleared']);
});

test('a recovered turn is done only if its completion was recorded, however its writes came out', async () => {
  const done: EffectRecord[] = [{ key: 'k', kind: 'write-working-copy', target: 'a', outcome: 'DONE' }];
  assert.equal(recoveredStatus({}, done, 1), 'stopped');
  assert.equal(recoveredStatus({ completed: true }, done, 1), 'done');
  assert.equal(recoveredStatus({ completed: true }, done, 0), 'stopped');
});

test('a prior refusal for a checkpoint name is honoured: not reported kept, and nothing is marked', async (t) => {
  const s = setup(t);
  const src = s.source();
  const existing = s.material.create(s.projectId, 'note.md', 'text/markdown', Buffer.from('theirs'), 'working', 'agent');
  s.put({ files: [note], sources: [{ name: 'source.md', version: 1 }] });
  const effects: EffectRecord[] = [{ key: 'k', kind: 'write-working-copy', target: 'note.md', outcome: 'REFUSED' }];
  const turn = await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')], effects }), async () => 'done', true);
  assert.deepEqual(s.written, []);
  assert.equal(s.material.load(existing.id)!.unsure, undefined);
  assert.doesNotMatch(turn.answer!.text, /kept for you to check/);
});

test('an accepted Stop outlives a kill: recovery drops the checkpoint and imports nothing', async (t) => {
  const s = setup(t);
  const src = s.source();
  s.put({ files: [note], sources: [{ name: 'source.md', version: 1 }] });
  await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')], stopRequested: true }), async () => 'interrupted', true);
  assert.deepEqual(s.written, []);
  assert.equal(s.saved, null);
});

test('recovery keeps a person\'s edit: the revision lands beside it', async (t) => {
  const s = setup(t);
  const src = s.source();
  await s.material.save(src.id, 'person', 1);
  s.put({ files: [{ name: 'source.md', body: 'agent', targetVersion: 1 }], sources: [{ name: 'source.md', version: 1 }] });
  await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')] }), async () => 'done', true);
  assert.equal(Buffer.from(s.material.bytes(src.id, 2)).toString(), 'person');
  assert.equal(s.material.load(src.id)!.current, 2);
  assert.deepEqual(s.names(), ['source.md', 'source (revision of v1).md']);
});

test('recovery holds what the single check would refuse: a source withdrawn since it was read', async (t) => {
  const s = setup(t);
  const src = s.source();
  s.material.withdraw(src.id);
  s.put({ files: [note], sources: [{ name: 'source.md', version: 1 }] });
  const turn = await s.run(s.newTurn({ reads: [s.read(src.id, 'source.md')] }), async () => 'done', true);
  assert.deepEqual(s.names(), []);
  assert.deepEqual(s.hidden().sort(), ['note (held).md', 'source.md']);
  assert.equal(turn.withheld, true);
});

test('a changed source holds the import rather than discarding it', async (t) => {
  const s = setup(t);
  const src = s.source();
  s.source('other.md');
  const turn = await s.run(s.newTurn(), async (tools) => {
    const sources = [];
    for (const name of ['source.md', 'other.md']) sources.push({ name, version: (await tools.read(name))!.version });
    await s.material.save(src.id, 'person', 1);
    assert.equal((await tools.writeIfVersion!('note.md', 'n', { targetVersion: null, sources }, new AbortController().signal)).outcome, 'DONE');
    return 'done';
  });
  const held = s.material.list(s.projectId, true).find((e) => e.name === 'note (held).md');
  assert.deepEqual(held?.held, { id: src.id, name: 'source.md', changed: true });
  assert.equal(turn.status, 'done');
  assert.match(turn.answer!.text, /source\.md changed while this turn worked/);
  assert.equal(turn.withheld, undefined);
  const now = workNow([], [held!], () => false);
  assert.match(now.needsYou[0]!.detail, /source\.md changed/);
});

test('a failed turn imports its last checkpoint; a finished one drops it, and so does Stop', async (t) => {
  const s = setup(t);
  s.source();
  const sources = [{ name: 'source.md', version: 1 }];
  const failed = await s.run(s.newTurn(), async (tools) => {
    await tools.read('source.md');
    await tools.checkpoint!([note], sources);
    return 'failed';
  });
  assert.equal(failed.status, 'stopped');
  assert.ok(s.names().includes('note.md'));
  assert.equal(s.saved, null);

  const s2 = setup(t);
  s2.source();
  await s2.run(s2.newTurn(), async (tools) => { await tools.read('source.md'); await tools.checkpoint!([note], sources); return 'done'; });
  assert.deepEqual(s2.names(), ['source.md']);
  assert.equal(s2.saved, null);
});


test('a failed producer imports no second copy of a stale target already kept beside it', async (t) => {
  const s = setup(t);
  const name = 'r/x.md';
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  const turn = await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(name));
    assert.ok((await s.material.save(target.id, 'Person second.', 1)).ok);
    const sources = [{ name, version: 1 }];
    await tools.checkpoint!([{ name, body: 'Agent revision.', targetVersion: 1 }], sources);
    assert.equal((await tools.writeIfVersion!(name, 'Agent revision.', { targetVersion: 1, sources }, new AbortController().signal)).outcome, 'DONE');
    return 'failed';
  });
  assert.equal(s.written.length, 1);
  assert.equal(turn.effects.length, 1);
  assert.equal(s.material.list(s.projectId).length, 2);
  assert.equal(s.saved, null);
});

for (const name of ['r/' + 'x'.repeat(490) + '.md', 'r/'.repeat(248) + 'x.md']) test('a held checkpoint matches its retained target after a cold projection: ' + name.length, async (t) => {
  const s = setup(t);
  const source = s.material.create(s.projectId, 'source.md', 'text/markdown', Buffer.from('Original.'), 'original', 'person');
  let saved: Checkpoint | null = null;
  const turn = await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(source.name));
    s.material.withdraw(source.id);
    const sources = [{ name: source.name, version: 1 }];
    await tools.checkpoint!([{ name, body: 'Held body.', targetVersion: null }], sources);
    assert.equal((await tools.writeIfVersion!(name, 'Held body.', { targetVersion: null, sources }, new AbortController().signal)).outcome, 'DONE');
    saved = structuredClone(s.saved);
    return 'done';
  });
  assert.ok(saved);
  s.put(JSON.parse(JSON.stringify(saved)));
  const effects = turn.effects.map(({ key, kind, target, outcome }) => ({ key, kind, target, outcome }));
  await s.run(s.newTurn({ effects, reads: turn.reads }), async () => { throw new Error('Recovery must not start the producer.'); }, true);
  assert.equal(s.written.length, 1);
  assert.equal(s.material.list(s.projectId, true).filter(entry => entry.held).length, 1);
});

test('an UNKNOWN stale-target write that committed is not proposed again in the same turn', async (t) => {
  const s = setup(t);
  const name = 'r/x.md';
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  s.commitUnknown();
  const outcomes: string[] = [];
  const turn = await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(name));
    assert.ok((await s.material.save(target.id, 'Person second.', 1)).ok);
    const sources = [{ name, version: 1 }];
    await tools.checkpoint!([{ name, body: 'Maybe committed.', targetVersion: 1 }], sources);
    for (let i = 0; i < 2; i++) outcomes.push((await tools.writeIfVersion!(name, 'Maybe committed.', { targetVersion: 1, sources }, new AbortController().signal)).outcome);
    return 'failed';
  });
  assert.deepEqual(outcomes, ['UNKNOWN', 'REFUSED']);
  assert.equal(s.written.length, 1);
  assert.equal(s.material.list(s.projectId).length, 2);
  assert.equal(turn.status, 'stopped');
  assert.equal(turn.work.steps.some(step => /revision was kept/.test(step.label)), false);
});


test('producer checkpoint refreshes preserve the original destination binding', async (t) => {
  const s = setup(t);
  const name = 'r/x.md';
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(name));
    assert.ok((await s.material.save(target.id, 'Person second.', 1)).ok);
    const sources = [{ name, version: 1 }], files = [{ name, body: 'Agent revision.', targetVersion: 1 }];
    await tools.checkpoint!(files, sources);
    assert.equal((await tools.writeIfVersion!(name, files[0].body, { targetVersion: 1, sources }, new AbortController().signal)).outcome, 'DONE');
    await tools.checkpoint!([], []);
    await tools.checkpoint!(files, sources);
    return 'failed';
  });
  assert.equal(s.written.length, 1);
  assert.equal(s.material.list(s.projectId).length, 2);
});

test('a legacy checkpoint recognises its already recorded beside effect', async (t) => {
  const s = setup(t);
  const name = 'release.notes/README';
  const original = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  assert.ok((await s.material.save(original.id, 'Person second.', 1)).ok);
  const kept = s.material.create(s.projectId, 'release.notes/README (revision of v1)', 'text/markdown', Buffer.from('Already kept.'), 'working', 'agent', undefined, 'managed');
  s.put({ files: [{ name, body: 'Already kept.', targetVersion: 1 }], sources: [{ name, version: 1 }] });
  const turn = await s.run(s.newTurn({ reads: [s.read(original.id, name)], effects: [{ key: 'legacy', kind: 'write-working-copy', target: kept.name, outcome: 'DONE' }] }), async () => { throw new Error('No producer on recovery.'); }, true);
  assert.deepEqual(s.written, []);
  assert.equal(s.material.list(s.projectId).length, 2);
  assert.equal(s.material.load(kept.id)?.unsure?.interrupted, true);
  assert.equal(turn.status, 'stopped');
});


test('a stale target and another changed source retain one held revision, also after reopen', async (t) => {
  const s = setup(t);
  const src = s.source();
  const name = 'r/x.md';
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  let result = '', snapshot: Checkpoint | null = null;
  const turn = await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(src.name));
    assert.ok(await tools.read(name));
    assert.ok((await s.material.save(target.id, 'Person target.', 1)).ok);
    assert.ok((await s.material.save(src.id, 'Person source.', 1)).ok);
    const sources = [{ name: src.name, version: 1 }, { name, version: 1 }];
    await tools.checkpoint!([{ name, body: 'Retained body.', targetVersion: 1 }], sources);
    result = (await tools.writeIfVersion!(name, 'Retained body.', { targetVersion: 1, sources }, new AbortController().signal)).outcome;
    snapshot = structuredClone(s.saved);
    return 'failed';
  });
  assert.equal(result, 'DONE');
  assert.equal(s.written.length, 1);
  const held = s.material.list(s.projectId, true).filter(entry => entry.held);
  assert.equal(held.length, 1);
  assert.equal(held[0].name, 'r/x (revision of v1) (held).md');
  assert.equal(held[0].held?.changed, true);
  assert.equal(Buffer.from(s.material.bytes(held[0].id, 1)).toString(), 'Retained body.');
  assert.equal(Buffer.from(s.material.bytes(target.id, 2)).toString(), 'Person target.');
  assert.equal(Buffer.from(s.material.bytes(src.id, 2)).toString(), 'Person source.');
  assert.ok(snapshot);
  s.put(JSON.parse(JSON.stringify(snapshot)));
  await s.run(s.newTurn({ reads: turn.reads, effects: JSON.parse(JSON.stringify(turn.effects)) }), async () => { throw new Error('No producer after reopen.'); }, true);
  assert.equal(s.written.length, 1);
  assert.equal(s.material.list(s.projectId, true).filter(entry => entry.held).length, 1);
});

test('a mixed legacy checkpoint retains legacy matching after a new write and another reopen', async (t) => {
  const s = setup(t);
  const src = s.source();
  const name = 'release.notes/README';
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  assert.ok((await s.material.save(target.id, 'Person target.', 1)).ok);
  const kept = s.material.create(s.projectId, 'release.notes/README (revision of v1)', 'text/markdown', Buffer.from('Old kept body.'), 'working', 'agent', undefined, 'managed');
  assert.ok((await s.material.save(src.id, 'Changed source.', 1)).ok);
  s.put({ files: [{ name: 'other/new.md', body: 'New body.', targetVersion: null }, { name, body: 'Old kept body.', targetVersion: 1 }], sources: [{ name: src.name, version: 1 }] });
  const turn = await s.run(s.newTurn({ reads: [s.read(src.id, src.name)], effects: [{ key: 'old', kind: 'write-working-copy', target: kept.name, outcome: 'DONE' }] }), async () => { throw new Error('No producer on legacy recovery.'); }, true);
  assert.equal(s.written.length, 1);
  assert.deepEqual(s.written, ['other/new (held).md']);
  assert.ok(s.lastSaved);
  s.put(JSON.parse(JSON.stringify(s.lastSaved)));
  await s.run(s.newTurn({ reads: turn.reads, effects: JSON.parse(JSON.stringify(turn.effects)) }), async () => { throw new Error('No producer on second recovery.'); }, true);
  assert.equal(s.written.length, 1);
  assert.equal(s.material.list(s.projectId, true).filter(entry => entry.name.includes('revision of')).length, 1);
});

test('a normal write creates no binding-only checkpoint or recovery work', async (t) => {
  const s = setup(t);
  let savedDuringWork: Checkpoint | null = null;
  await s.run(s.newTurn(), async tools => {
    assert.equal((await tools.writeIfVersion!('plain.md', 'Body.', { targetVersion: null, sources: [] }, new AbortController().signal)).outcome, 'DONE');
    savedDuringWork = structuredClone(s.saved);
    return 'done';
  });
  assert.equal(savedDuringWork, null);
  assert.equal(s.written.length, 1);
});

test('a concurrent literal target cannot take a retained destination before proposal', async (t) => {
  const s = setup(t);
  const source = s.material.create(s.projectId, 'source.md', 'text/markdown', Buffer.from('Source.'), 'original', 'person');
  let ready!: () => void, release!: () => void;
  const reserved = new Promise<void>(resolve => { ready = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const save = s.checkpoints.save;
  let paused = false;
  s.checkpoints.save = async checkpoint => {
    await save(checkpoint);
    if (!paused && checkpoint.imports?.some(binding => binding.name === 'r/x.md' && binding.target !== binding.name)) {
      paused = true; ready(); await proceed;
    }
  };
  let results: string[] = [];
  await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(source.name));
    s.material.withdraw(source.id);
    const sources = [{ name: source.name, version: 1 }];
    await tools.checkpoint!([{ name: 'r/x.md', body: 'First body.', targetVersion: null }], sources);
    const first = tools.writeIfVersion!('r/x.md', 'First body.', { targetVersion: null, sources }, new AbortController().signal);
    await reserved;
    const second = tools.writeIfVersion!('r/x (held).md', 'Competing body.', { targetVersion: null, sources }, new AbortController().signal);
    release();
    results = (await Promise.all([first, second])).map(result => result.outcome);
    return 'done';
  });
  assert.deepEqual(results, ['DONE', 'REFUSED']);
  assert.equal(s.written.length, 1);
  const held = s.material.list(s.projectId, true).filter(entry => entry.held);
  assert.equal(held.length, 1);
  assert.equal(Buffer.from(s.material.bytes(held[0].id, 1)).toString(), 'First body.');
});

test('retained destinations leave the other checkpoint file names available to their own requests', async (t) => {
  const s = setup(t);
  const source = s.material.create(s.projectId, 'source.md', 'text/markdown', Buffer.from('Source.'), 'original', 'person');
  const turn = await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(source.name));
    s.material.withdraw(source.id);
    const sources = [{ name: source.name, version: 1 }];
    await tools.checkpoint!([{ name: 'r/x.md', body: 'First body.', targetVersion: null }, { name: 'r/x (held).md', body: 'Second body.', targetVersion: null }], sources);
    assert.equal((await tools.writeIfVersion!('r/x.md', 'First body.', { targetVersion: null, sources }, new AbortController().signal)).outcome, 'DONE');
    return 'failed';
  });
  const held = s.material.list(s.projectId, true).filter(entry => entry.held);
  assert.equal(held.length, 2, turn.answer?.text ?? 'No answer.');
  assert.deepEqual(held.map(entry => Buffer.from(s.material.bytes(entry.id, 1)).toString()).sort(), ['First body.', 'Second body.']);
  assert.equal(s.written.length, 2);
});

test('an intermediate binding never claims retention for a different requested checkpoint file', async (t) => {
  const s = setup(t);
  const src = s.source();
  const name = 'r/x.md';
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  const turn = await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(src.name)); assert.ok(await tools.read(name));
    assert.ok((await s.material.save(src.id, 'Changed source.', 1)).ok);
    assert.ok((await s.material.save(target.id, 'Person target.', 1)).ok);
    const sources = [{ name: src.name, version: 1 }, { name, version: 1 }];
    await tools.checkpoint!([{ name, body: 'First retained body.', targetVersion: 1 }], sources);
    assert.equal((await tools.writeIfVersion!(name, 'First retained body.', { targetVersion: 1, sources }, new AbortController().signal)).outcome, 'DONE');
    await tools.checkpoint!([{ name: 'r/x (revision of v1).md', body: 'Different requested body.', targetVersion: null }], sources);
    return 'failed';
  });
  assert.equal(s.written.length, 1);
  assert.equal(turn.answer?.text.includes('These pieces were kept for you to check'), false, 'the earlier request does not count as this checkpoint file');
});

test('withdrawal during destination persistence retains a held revision without changing the person version', async (t) => {
  const s = setup(t);
  const source = s.material.create(s.projectId, 'source.md', 'text/markdown', Buffer.from('Original source.'), 'original', 'person');
  const name = 'r/x.md';
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  const save = s.checkpoints.save;
  let withdrew = false, result = '';
  s.checkpoints.save = async checkpoint => {
    await save(checkpoint);
    if (!withdrew && checkpoint.imports?.some(binding => binding.name === name && binding.target !== name)) {
      withdrew = true; s.material.withdraw(source.id);
    }
  };
  const turn = await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(source.name)); assert.ok(await tools.read(name));
    assert.ok((await s.material.save(target.id, 'Person version.', 1)).ok);
    const sources = [{ name: source.name, version: 1 }, { name, version: 1 }];
    await tools.checkpoint!([{ name, body: 'Held work.', targetVersion: 1 }], sources);
    result = (await tools.writeIfVersion!(name, 'Held work.', { targetVersion: 1, sources }, new AbortController().signal)).outcome;
    return 'failed';
  });
  assert.equal(result, 'DONE');
  assert.equal(withdrew, true);
  assert.equal(s.written.length, 1);
  const held = s.material.list(s.projectId, true).filter(entry => entry.held);
  assert.equal(held.length, 1);
  assert.equal(held[0].held?.id, source.id);
  assert.equal(Buffer.from(s.material.bytes(held[0].id, 1)).toString(), 'Held work.');
  assert.equal(Buffer.from(s.material.bytes(target.id, 2)).toString(), 'Person version.');
  assert.equal(turn.withheld, true);
});


test('a pending identity reservation is re-derived after the person edits its target before reopen', async (t) => {
  const s = setup(t);
  const name = 'r/x.md';
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('First.'), 'working', 'agent', undefined, 'managed');
  assert.ok((await s.material.save(target.id, 'Person second.', 1)).ok);
  s.put({ files: [{ name, body: 'Pending work.', targetVersion: 1 }], sources: [{ name, version: 1 }], imports: [{ name, target: name, requested: name }] });
  const turn = await s.run(s.newTurn({ reads: [s.read(target.id, name)] }), async () => { throw new Error('No producer in recovery.'); }, true);
  assert.equal(s.written.length, 1);
  assert.equal(turn.effects[0]?.outcome, 'DONE');
  const retained = s.material.list(s.projectId).find(entry => entry.id !== target.id)!;
  assert.ok(retained);
  assert.equal(retained.name, 'r/x (revision of v1).md');
  assert.equal(Buffer.from(s.material.bytes(retained.id, 1)).toString(), 'Pending work.');
  assert.equal(Buffer.from(s.material.bytes(target.id, 2)).toString(), 'Person second.');
});

test('a pending identity reservation is re-derived when its source is withdrawn before reopen', async (t) => {
  const s = setup(t);
  const source = s.material.create(s.projectId, 'source.md', 'text/markdown', Buffer.from('Source.'), 'original', 'person');
  const name = 'r/x.md';
  s.material.withdraw(source.id);
  s.put({ files: [{ name, body: 'Pending work.', targetVersion: null }], sources: [{ name: source.name, version: 1 }], imports: [{ name, target: name, requested: name }] });
  const turn = await s.run(s.newTurn({ reads: [s.read(source.id, source.name)] }), async () => { throw new Error('No producer in recovery.'); }, true);
  assert.equal(s.written.length, 1);
  const held = s.material.list(s.projectId, true).filter(entry => entry.held);
  assert.equal(held.length, 1);
  assert.equal(held[0].held?.id, source.id);
  assert.equal(Buffer.from(s.material.bytes(held[0].id, 1)).toString(), 'Pending work.');
  assert.equal(turn.withheld, true);
});

test('a pending retained reservation is re-derived when its source is available again', async (t) => {
  const s = setup(t);
  const source = s.source();
  // Retiring and keeping a working source changes its visibility without inventing a new version.
  s.material.mark(source.id, { hidden: true });
  const name = 'r/x.md';
  const checkpoint: Checkpoint = { files: [{ name, body: 'Pending work.', targetVersion: null }], sources: [{ name: source.name, version: 1 }], imports: [{ name, target: 'r/x (held).md', requested: name }] };
  s.material.mark(source.id, { hidden: false });
  s.put(checkpoint);
  const turn = await s.run(s.newTurn({ reads: [s.read(source.id, source.name)] }), async () => { throw new Error('No producer in recovery.'); }, true);
  assert.deepEqual(s.written, [name]);
  const retained = s.material.list(s.projectId).find(entry => entry.name === name)!;
  assert.ok(retained);
  assert.equal(retained.held, undefined);
  assert.equal(Buffer.from(s.material.bytes(retained.id, 1)).toString(), 'Pending work.');
  assert.equal(turn.effects[0]?.outcome, 'DONE');
});

test('a corrupt binding cycle with a recorded effect refuses without crashing recovery', async (t) => {
  const s = setup(t);
  const kept = s.material.create(s.projectId, 'r/kept.md', 'text/markdown', Buffer.from('Recorded body.'), 'working', 'agent', undefined, 'managed');
  const name = 'r/request.md';
  s.put({ files: [{ name, body: 'Recorded body.', targetVersion: null }], sources: [], imports: [{ name, target: kept.name, requested: name }, { name: kept.name, target: name, requested: name }] });
  const turn = await s.run(s.newTurn({ effects: [{ key: 'recorded', kind: 'write-working-copy', target: kept.name, outcome: 'DONE' }] }), async () => { throw new Error('No producer in recovery.'); }, true);
  assert.deepEqual(s.written, []);
  assert.equal(turn.status, 'stopped');
  assert.ok(turn.work.steps.some(step => /destination.*inconsistent/i.test(step.label)));
  assert.equal(Buffer.from(s.material.bytes(kept.id, 1)).toString(), 'Recorded body.');
});

// A held recovery copy is private retention, never a rebase onto the current target.
test('withdrawal plus a person target edit retains the recovered body as held work', async t => {
  const s = setup(t);
  const source = s.material.create(s.projectId, 'source.md', 'text/markdown', Buffer.from('Source.'), 'original', 'person');
  const name = 'r/target.md';
  const target = s.material.create(s.projectId, name, 'text/markdown', Buffer.from('Initial.'), 'working', 'agent', undefined, 'managed');
  assert.ok((await s.material.save(target.id, 'Person edit.', 1)).ok);
  s.material.withdraw(source.id);
  s.put({ files: [{ name, body: 'Staged body that must remain recoverable.', targetVersion: 1 }], sources: [{ name: source.name, version: 1 }, { name, version: 1 }], imports: [{ name, target: 'r/target (revision of v1).md', requested: name }] });
  const turn = await s.run(s.newTurn({ reads: [s.read(source.id, source.name), s.read(target.id, name)] }), async () => { throw Error('No producer during recovery.'); }, true);
  assert.equal(Buffer.from(s.material.bytes(target.id, 2)).toString(), 'Person edit.');
  const held = s.material.list(s.projectId, true).filter(entry => entry.held);
  assert.equal(held.length, 1, JSON.stringify({ answer: turn.answer, effects: turn.effects, checkpoint: s.saved, proposed: s.written }));
  assert.equal(Buffer.from(s.material.bytes(held[0].id, 1)).toString(), 'Staged body that must remain recoverable.');
  assert.equal(turn.withheld, true);
  assert.match(turn.answer!.text, /r\/target\.md changed while this turn worked/);
});

test('held retention preserves its unchanged source binding while isolating changed sources and the person target', async t => {
 const s=setup(t);
 const withdrawn=s.material.create(s.projectId,'withdrawn.md','text/markdown',Buffer.from('Original.'),'original','person');
 const moved=s.source('changed.md'), unchanged=s.source('unchanged.md');
 const name='r/target.md';
 const target=s.material.create(s.projectId,name,'text/markdown',Buffer.from('Target one.'),'working','agent',undefined,'managed');
 assert.ok((await s.material.save(moved.id,'Changed source.',1)).ok);
 assert.ok((await s.material.save(target.id,'Person target.',1)).ok);
 s.material.withdraw(withdrawn.id);
 const entries=[withdrawn,moved,unchanged,target];
 s.put({files:[{name,body:'Held draft.',targetVersion:1}],sources:entries.map(e=>({name:e.name,version:1}))});
 const turn=await s.run(s.newTurn({reads:entries.map(e=>s.read(e.id,e.name))}),async()=>{throw Error('No producer on recovery.');},true);
 assert.equal(s.proposed.length,1);
 assert.deepEqual(s.proposed[0].sourceVersions?.map(e=>({id:e.id,name:e.name,version:e.version})),[{id:unchanged.id,name:unchanged.name,version:1}]);
 const held=s.material.list(s.projectId,true).filter(e=>e.held);
 assert.equal(held.length,1);assert.equal(held[0].hidden,true);assert.equal(held[0].held?.id,withdrawn.id);
 assert.equal(Buffer.from(s.material.bytes(held[0].id,1)).toString(),'Held draft.');
 assert.equal(Buffer.from(s.material.bytes(target.id,2)).toString(),'Person target.');
 assert.equal(Buffer.from(s.material.bytes(withdrawn.id,1)).toString(),'Original.');
 assert.equal(turn.withheld,true);
 assert.match(turn.answer!.text, /changed\.md/);
 assert.match(turn.answer!.text, /r\/target\.md/);
 assert.match(turn.answer!.text, /changed while this turn worked/);
});

test('ordinary writes still refuse the person edit rather than discarding that dependency', async t => {
 const s=setup(t), target=s.source('ordinary.md');
 let outcome='';
 await s.run(s.newTurn(),async tools=>{
  assert.ok(await tools.read(target.name));
  assert.ok((await s.material.save(target.id,'Person edit.',1)).ok);
  outcome=(await tools.write(target.name,'Agent revision.',new AbortController().signal)).outcome;
  return 'done';
 });
 assert.equal(outcome,'REFUSED');assert.deepEqual(s.written,[]);
 assert.equal(Buffer.from(s.material.bytes(target.id,2)).toString(),'Person edit.');
});


test('an ordinary write after withdrawal still refuses a changed dependency', async t => {
  const s = setup(t);
  const withdrawn = s.source('withdrawn.md'), changed = s.source('changed.md');
  let outcome = '';
  await s.run(s.newTurn(), async tools => {
    assert.ok(await tools.read(withdrawn.name));
    assert.ok(await tools.read(changed.name));
    s.material.withdraw(withdrawn.id);
    assert.ok((await s.material.save(changed.id, 'Person edit.', 1)).ok);
    outcome = (await tools.write('draft.md', 'Agent draft.', new AbortController().signal)).outcome;
    return 'done';
  });
  assert.equal(outcome, 'REFUSED');
  assert.deepEqual(s.written, []);
  assert.equal(Buffer.from(s.material.bytes(changed.id, 2)).toString(), 'Person edit.');
});
