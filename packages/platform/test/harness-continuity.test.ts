import { syntheticMaterialReader } from './fixtures/synthetic-material-reader.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Turn } from '../src/api.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import type { HarnessV1, ToolHost, WriteOutcome } from '../src/ports/harness.ts';
import type { Gateway } from '../src/stub/harness.ts';
import { MaterialStore } from '../src/stub/material.ts';

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'harness-continuity-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const projectId = 'project';
  const signal = new AbortController().signal;
  const create = (name: string, text = 'base') => material.create(projectId, name, 'text/markdown', Buffer.from(text), 'working', 'agent');
  let proposals = 0;
  const keys = new Map<string, string>();
  const bases: (number | null)[] = [];
  let beforePerform = async () => {};
  const gateway: Gateway = {
    read: syntheticMaterialReader(home, material, projectId),
    async write(target, effect, perform) {
      const arguments_ = JSON.stringify(target);
      const prior = keys.get(target.name);
      if (prior && prior !== arguments_) throw new Error('reused_key: changed arguments under turn:name');
      keys.set(target.name, arguments_);
      proposals++;
      bases.push(target.baseVersion);
      await beforePerform();
      try {
        const result = await perform();
        if (result === 'stopped') return undefined;
        effect.outcome = 'DONE';
        return result;
      } catch (error) {
        effect.outcome = 'REFUSED';
        effect.detail = String(error);
        return undefined;
      }
    },
  };
  async function run(work: (tools: ToolHost) => Promise<void>) {
    const harness: HarnessV1 = {
      specificationVersion: 'v1', id: 'test', label: 'test',
      start(_request, { tools }) {
        const outcome = work(tools).then(() => ({ status: 'done' as const, answer: 'Test completed.', usage: { input: 0, output: 0 } }));
        return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
      },
    };
    const turn: Turn = {
      id: 'turn', side: false, user: { text: 'Update the draft.', attachments: [], at: '2026-10-27T00:00:00Z' },
      work: { startedAt: '2026-10-27T00:00:00Z', harness: 'test', steps: [] }, effects: [], status: 'running',
    };
    await runHarnessTurn({ material, projectId, gateway, writeDelayMs: 0, signal, threadId: 'thread', harness,
      route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'test', label: 'test', credential: null },
      credential: async () => { throw new Error('No credential in this test'); }, history: [], resumed: false, progress() {},
    }, turn, []);
    return turn;
  }
  const text = (id: string) => {
    const entry = material.load(id);
    assert.ok(entry);
    return Buffer.from(material.bytes(id, entry.current)).toString();
  };
  return { material, projectId, create, signal, run, text, bases, get proposals() { return proposals; },
    beforePerform(fn: () => Promise<void>) { beforePerform = fn; } };
}

test('an unchanged read target is written from the version read', async (t) => {
  const s = setup(t);
  const draft = s.create('draft.md');
  let result: WriteOutcome | undefined;
  const turn = await s.run(async (tools) => {
    assert.equal((await tools.read('draft.md'))?.version, 1);
    result = await tools.write('draft.md', 'agent revision', s.signal);
  });
  assert.equal(result?.outcome, 'DONE');
  assert.deepEqual(s.bases, [1]);
  assert.equal(s.text(draft.id), 'agent revision');
  assert.equal(turn.answer?.files[0]?.version, 2);
});

test('a person edit after the read survives and is refused before proposal', async (t) => {
  const s = setup(t);
  const draft = s.create('draft.md');
  let result: WriteOutcome | undefined;
  await s.run(async (tools) => {
    await tools.read('draft.md');
    assert.equal((await s.material.save(draft.id, 'person v2', 1)).ok, true);
    result = await tools.write('draft.md', 'stale agent text', s.signal);
  });
  assert.equal(result?.outcome, 'REFUSED');
  assert.equal(s.proposals, 0);
  assert.equal(s.text(draft.id), 'person v2');
  assert.equal(s.material.load(draft.id)?.current, 2);
  assert.equal(Buffer.from(s.material.bytes(draft.id, 1)).toString(), 'base');
});

test('a source edit also prevents creation of a stale derived artifact', async (t) => {
  const s = setup(t);
  const source = s.create('source.md');
  let result: WriteOutcome | undefined;
  await s.run(async (tools) => {
    await tools.read('source.md');
    await s.material.save(source.id, 'new facts', 1);
    result = await tools.write('summary.md', 'summary of old facts', s.signal);
  });
  assert.equal(result?.outcome, 'REFUSED');
  assert.equal(s.proposals, 0);
  assert.equal(s.material.list(s.projectId).some((x) => x.name === 'summary.md'), false);
});

test('a person edit during dispatch wait is caught before material changes', async (t) => {
  const s = setup(t);
  const draft = s.create('draft.md');
  s.beforePerform(async () => { await s.material.save(draft.id, 'person v2', 1); });
  let result: WriteOutcome | undefined;
  await s.run(async (tools) => {
    await tools.read('draft.md');
    result = await tools.write('draft.md', 'stale agent text', s.signal);
  });
  assert.equal(result?.outcome, 'REFUSED');
  assert.deepEqual(s.bases, [1]);
  assert.equal(s.text(draft.id), 'person v2');
});

test('a target created during dispatch is not overwritten or duplicated', async (t) => {
  const s = setup(t);
  let personId = '';
  s.beforePerform(async () => { personId = s.create('new.md', 'person document').id; });
  let result: WriteOutcome | undefined;
  await s.run(async (tools) => { result = await tools.write('new.md', 'agent draft', s.signal); });
  assert.equal(result?.outcome, 'REFUSED');
  assert.equal(s.text(personId), 'person document');
  assert.equal(s.material.list(s.projectId).filter((x) => x.name === 'new.md').length, 1);
});

test('listing an existing document does not grant an unread replacement', async (t) => {
  const s = setup(t);
  const draft = s.create('draft.md', 'person text');
  let result: WriteOutcome | undefined;
  const turn = await s.run(async (tools) => {
    await tools.list();
    result = await tools.write('draft.md', 'unread replacement', s.signal);
  });
  assert.equal(result?.outcome, 'REFUSED');
  assert.equal(s.proposals, 0);
  assert.equal(s.text(draft.id), 'person text');
  assert.equal(turn.status, 'refused', 'a local write refusal cannot become an empty Done answer');
  assert.match(turn.answer?.text ?? '', /read/i);
});

test('an explicit reread of the saved version allows a deliberate revision', async (t) => {
  const s = setup(t);
  const draft = s.create('draft.md');
  let result: WriteOutcome | undefined;
  await s.run(async (tools) => {
    await tools.read('draft.md');
    await s.material.save(draft.id, 'person v2', 1);
    assert.equal((await tools.read('draft.md'))?.text, 'person v2');
    result = await tools.write('draft.md', 'revision using person v2', s.signal);
  });
  assert.equal(result?.outcome, 'DONE');
  assert.deepEqual(s.bases, [2]);
  assert.equal(s.text(draft.id), 'revision using person v2');
  assert.equal(Buffer.from(s.material.bytes(draft.id, 2)).toString(), 'person v2');
});

test('a later concurrent read cannot rebase a write that is already pending', async (t) => {
  const s = setup(t);
  const source = s.create('source.md');
  let tools_: ToolHost;
  s.beforePerform(async () => {
    await s.material.save(source.id, 'person v2', 1);
    assert.equal((await tools_.read('source.md'))?.version, 2);
  });
  let result: WriteOutcome | undefined;
  await s.run(async (tools) => {
    tools_ = tools;
    await tools.read('source.md');
    result = await tools.write('summary.md', 'summary of v1', s.signal);
  });
  assert.equal(result?.outcome, 'REFUSED');
  assert.equal(s.material.list(s.projectId).some((x) => x.name === 'summary.md'), false);
});

test('a result cites the agent version while a subsequent person save stays current', async (t) => {
  const s = setup(t);
  const draft = s.create('draft.md');
  const turn = await s.run(async (tools) => {
    await tools.read('draft.md');
    const result = await tools.write('draft.md', 'agent v2', s.signal);
    assert.equal(result.outcome, 'DONE');
    await s.material.save(draft.id, 'person v3', 2);
  });
  assert.equal(s.text(draft.id), 'person v3');
  assert.equal(turn.answer?.files[0]?.version, 2);
  assert.equal(Buffer.from(s.material.bytes(draft.id, 2)).toString(), 'agent v2');
});

test('a dispatch refusal cannot be retried with changed arguments under the same turn key', async (t) => {
  const s = setup(t);
  const draft = s.create('draft.md');
  s.beforePerform(async () => { await s.material.save(draft.id, 'person v2', 1); });
  await s.run(async (tools) => {
    await tools.read('draft.md');
    assert.equal((await tools.write('draft.md', 'stale revision', s.signal)).outcome, 'REFUSED');
    await tools.read('draft.md');
    const again = await tools.write('draft.md', 'corrected revision', s.signal);
    assert.equal(again.outcome, 'REFUSED');
    if (again.outcome === 'REFUSED') assert.match(again.detail, /new turn/);
  });
  assert.equal(s.proposals, 1);
  assert.equal(s.text(draft.id), 'person v2');
});
