// What crosses, and when nothing may: writes go only through the ToolHost's conditional crossing, and a
// run or a steer whose request has not left when Stop comes never leaves. Against a fake Hermes host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolHost } from '@backbone-next/platform/ports';
import { HermesClient } from '../src/client.ts';
import { context, fakeHost, note, request, run, setup, tools, write } from './support.ts';

test('a write crosses only through writeIfVersion, on the version the turn read or as a new file, citing what it read', async () => {
  const s = await setup();
  const { host, writes, unconditional } = fakeHost([note, { ...note, name: 'other.md', version: 4 }]);
  s.hermes.queue({ tool: 'door_read_file', args: { name: 'note.md' } }, write('note.md', '# Revenue\nUp 5%.'), write('brief.md'), { end: 'completed', output: 'ok' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'done');
  assert.deepEqual(unconditional, [], 'never the unconditional write');
  assert.deepEqual(writes.map((w) => [w.name, w.base]), [
    ['note.md', { targetVersion: 1, sources: [{ name: 'note.md', version: 1 }] }],
    ['brief.md', { targetVersion: null, sources: [{ name: 'note.md', version: 1 }] }],
  ]);
  await s.done();
});

test('a ToolHost with no conditional crossing gets no write: it is refused and closes further writes', async () => {
  const s = await setup();
  const { host, unconditional } = fakeHost([]);
  const plain: ToolHost = { list: host.list, read: host.read, write: host.write };
  s.hermes.queue(write(), write('other.md'), { end: 'completed', output: 'Could not write.' });
  const { events } = await run(s.harness.start(request(), context(plain)));
  assert.deepEqual(unconditional, [], 'no fallback to the unconditional write');
  assert.match(s.hermes.toldModel[0], /no conditional write/);
  assert.equal(tools(events, 'refused').length, 2);
  await s.done();
});

/** Holds the client's header step for the first request to a path that matches, so Stop can land in that gap. */
function holdHeaders(match: (path: string) => boolean) {
  const proto = HermesClient.prototype as unknown as { headers(...args: unknown[]): Promise<unknown> };
  const original = proto.headers;
  let held!: () => void;
  const reached = new Promise<void>((r) => (held = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let armed = true;
  proto.headers = async function (this: unknown, ...args: unknown[]) {
    if (armed && typeof args[0] === 'string' && match(args[0])) {
      armed = false;
      held();
      await gate;
    }
    return original.apply(this, args);
  };
  const within = (ms: number) => Promise.race([reached.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  return { within, release, restore: () => (proto.headers = original) };
}

test('a steer whose request had not left when Stop came settles NOT_DELIVERED and is never sent', async () => {
  const s = await setup();
  const hold = holdHeaders((path) => path.endsWith('/steer'));
  try {
    s.hermes.queue({ hold: 'steer' }, { end: 'completed', output: 'ok' });
    const turn = s.harness.start(request(), context(fakeHost([]).host));
    const running = run(turn);
    await s.hermes.reached('steer');
    const delivered = turn.deliver!('Shorter, please.');
    assert.ok(await hold.within(2_000), 'the steer reached its header step');
    turn.stop();
    hold.release();
    assert.equal((await delivered).outcome, 'NOT_DELIVERED');
    s.hermes.release('steer');
    await running;
    assert.deepEqual(s.hermes.steers, []);
  } finally {
    hold.restore();
    await s.done();
  }
});

test('a run whose request had not left when Stop came is never submitted', async () => {
  const s = await setup();
  const hold = holdHeaders((path) => path === '/v1/runs');
  try {
    s.hermes.queue({ end: 'completed', output: 'never' });
    const turn = s.harness.start(request(), context(fakeHost([]).host));
    const running = run(turn);
    assert.ok(await hold.within(2_000), 'the run reached its header step');
    turn.stop();
    hold.release();
    const { outcome } = await running;
    assert.equal(outcome.status, 'interrupted');
    assert.equal(s.hermes.posts.length, 0, 'nothing was submitted');
  } finally {
    hold.restore();
    await s.done();
  }
});
