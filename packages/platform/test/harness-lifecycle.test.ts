import { syntheticMaterialReader } from './fixtures/synthetic-material-reader.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Turn } from '../src/api.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import type { HarnessV1, TurnContext, TurnOutcome } from '../src/ports/harness.ts';
import type { Gateway } from '../src/stub/harness.ts';
import { MaterialStore } from '../src/stub/material.ts';

function setup(t: TestContext, start: HarnessV1['start']) {
  const home = mkdtempSync(join(tmpdir(), 'harness-lifecycle-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const begun = new Promise<void>((r) => { entered = r; });
  let target_: Parameters<Gateway['write']>[0] | undefined;
  const gateway: Gateway = {
    conditionalWrites: true,
    read: syntheticMaterialReader(home, material, 'project', { signal: controller.signal }),
    async write(target, effect, perform) {
      target_ = target;
      effect.key = 'original-write';
      entered();
      await held;
      try {
        const result = await perform();
        if (result === 'stopped') { effect.detail = 'UNKNOWN; it will not be resent.'; return undefined; }
        effect.outcome = 'DONE';
        return result;
      } catch (error) { effect.outcome = 'REFUSED'; effect.detail = String(error); return undefined; }
    },
  };
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Create a draft', attachments: [], at: '' },
    work: { startedAt: '', harness: 'controlled', steps: [] }, effects: [], status: 'running' };
  const run = () => runHarnessTurn({ material, projectId: 'project', gateway, writeDelayMs: 0, signal: controller.signal,
    threadId: 'thread', harness: { specificationVersion: 'v1', id: 'controlled', label: 'controlled', start },
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'controlled', label: 'controlled', credential: null },
    credential: async () => { throw new Error('No credential in this test'); }, history: [], resumed: false, progress() {},
  }, turn, []);
  return { material, controller, turn, run, release, begun, target: () => target_ };
}
const interrupted: TurnOutcome = { status: 'interrupted', answer: '', usage: { input: 0, output: 0 } };
const done: TurnOutcome = { status: 'done', answer: 'Done', usage: { input: 0, output: 0 } };
const events = async function* () {};

test('a stopped producer cannot finish ahead of an already pending host write', async (t) => {
  const s = setup(t, (_request, context) => {
    void context.tools.write('draft.md', 'agent draft', new AbortController().signal);
    return { events: events(), outcome: Promise.resolve(interrupted), stop() {}, steer() {} };
  });
  let finished = false;
  const running = s.run().then(() => { finished = true; });
  await s.begun;
  s.controller.abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(finished, false);
  s.release();
  await running;
  assert.equal(s.turn.status, 'stopped');
  assert.equal(s.turn.effects[0].key, 'original-write');
  assert.equal(s.turn.effects[0].outcome, 'UNKNOWN');
  assert.deepEqual(s.material.list('project'), []);
});

test('a producer throwing during start still joins and exposes a committed result', async (t) => {
  const s = setup(t, (_request, context) => {
    void context.tools.write('draft.md', 'committed before producer failed', new AbortController().signal);
    throw new Error('producer failed');
  });
  const running = s.run();
  await s.begun;
  s.release();
  await running;
  assert.equal(s.turn.status, 'stopped');
  assert.equal(s.turn.effects[0].outcome, 'DONE');
  assert.equal(s.turn.answer?.files[0]?.version, 1);
  assert.equal(s.turn.answer?.files[0]?.name, 'draft.md');
});

test('conditional imports carry actual source identities and stay managed', async (t) => {
  let context_: TurnContext;
  const s = setup(t, (_request, context) => {
    context_ = context;
    const outcome = (async () => {
      const read = await context.tools.read('source.md');
      assert.ok(read);
      assert.ok(context.tools.writeIfVersion);
      assert.equal((await context.tools.writeIfVersion('draft.md', 'new document', { targetVersion: null, sources: [{ name: 'source.md', version: read.version }] }, new AbortController().signal)).outcome, 'DONE');
      return done;
    })();
    return { events: events(), outcome, stop() {}, steer() {} };
  });
  const source = s.material.create('project', 'source.md', 'text/markdown', Buffer.from('source'), 'original', 'person');
  const running = s.run();
  await s.begun;
  assert.deepEqual(s.target()?.sourceVersions, [{ id: source.id, name: 'source.md', version: 1 }]);
  s.release();
  await running;
  assert.equal(s.material.list('project').find((x) => x.name === 'draft.md')?.projection, 'managed');
  assert.equal((await context_!.tools.write('late.md', 'late', new AbortController().signal)).outcome, 'REFUSED');
  assert.equal(s.material.list('project').some((x) => x.name === 'late.md'), false);
});

test('one turn revises several documents staged from the same sources', async (t) => {
  const outcomes: string[] = [];
  const s = setup(t, (_request, context) => {
    const outcome = (async () => {
      const first = await context.tools.read('first.md');
      const second = await context.tools.read('second.md');
      assert.ok(first && second && context.tools.writeIfVersion);
      const sources = [{ name: 'first.md', version: first.version }, { name: 'second.md', version: second.version }];
      for (const name of ['first.md', 'second.md']) {
        outcomes.push((await context.tools.writeIfVersion(name, `${name} revised`, { targetVersion: 1, sources }, new AbortController().signal)).outcome);
      }
      return done;
    })();
    return { events: events(), outcome, stop() {}, steer() {} };
  });
  for (const name of ['first.md', 'second.md']) s.material.create('project', name, 'text/markdown', Buffer.from(name), 'working', 'agent');
  const running = s.run();
  await s.begun;
  s.release();
  await running;
  assert.deepEqual(outcomes, ['DONE', 'DONE']);
  assert.deepEqual(s.material.list('project').map((x) => x.current).sort(), [2, 2]);
});

test('a detached write rejected before effect creation cannot turn into Done', async (t) => {
  const s = setup(t, (_request, context) => {
    void context.tools.write('draft.md', 'not written', new AbortController().signal).catch(() => {});
    return { events: events(), outcome: Promise.resolve(done), stop() {}, steer() {} };
  });
  s.material.list = () => { throw new Error('Controlled material preflight failure'); };
  await s.run();
  assert.equal(s.turn.status, 'stopped');
  assert.deepEqual(s.turn.effects, [], 'a local error must not invent a Kernel receipt');
  assert.deepEqual(s.turn.answer?.files, []);
  assert.match(s.turn.answer?.text ?? '', /could not finish/);
});
