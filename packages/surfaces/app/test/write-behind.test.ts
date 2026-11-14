import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWriteBehind } from '../src/lib/write-behind.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test('pending edits coalesce by key without dropping another document', async () => {
  const committed = new Map<string, string>();
  const writer = createWriteBehind<string>({ delay: 60_000, async write(batch) { for (const item of batch) committed.set(...item); } });
  const saved = [writer.set('file', 'older'), writer.set('composer', 'next message'), writer.set('file', 'latest')];
  assert.equal(writer.get('file'), 'latest');
  await writer.flush();
  await Promise.all(saved);
  assert.deepEqual([...committed], [['file', 'latest'], ['composer', 'next message']]);
});

test('an in-flight autosave finishes before its clear; a concurrent flush joins the drain', async () => {
  const held = deferred();
  const begun = deferred();
  const writes: string[] = [];
  const writer = createWriteBehind<string>({ delay: 60_000, async write(batch) {
    const value = batch.get('file')!;
    if (value === 'older') { begun.resolve(); await held.promise; }
    writes.push(value);
  } });
  const first = writer.set('file', 'older');
  const flushing = writer.flush();
  await begun.promise;
  const clear = writer.set('file', '');
  assert.equal(writer.get('file'), '');
  assert.deepEqual(writes, []);
  const joined = writer.flush();
  assert.equal(joined, flushing);
  held.resolve();
  await Promise.all([first, clear, flushing, joined]);
  assert.deepEqual(writes, ['older', '']);
  assert.equal(writer.get('file'), undefined);
});

test('a failed old request retains the latest edit and never acknowledges it as saved', async () => {
  const held = deferred();
  const begun = deferred();
  const failure = new Error('transport lost');
  const writes: string[] = [];
  const writer = createWriteBehind<string>({ delay: 60_000, async write(batch) {
    const value = batch.get('file')!;
    if (value === 'older') { begun.resolve(); await held.promise; throw failure; }
    writes.push(value);
  } });
  const first = writer.set('file', 'older').catch((error: unknown) => error);
  const flush = writer.flush();
  await begun.promise;
  const latest = writer.set('file', 'latest').catch((error: unknown) => error);
  held.resolve();
  await assert.rejects(flush, /transport lost/);
  assert.equal(await first, failure);
  assert.equal(await latest, failure);
  assert.equal(writer.get('file'), 'latest');
  await writer.flush();
  assert.deepEqual(writes, ['latest']);
});

test('new typing queued by an error handler is not stranded behind the failed drain', { timeout: TEST_HANG_MS * 2 }, async () => {
  const writes: string[] = [];
  const writer = createWriteBehind<string>({ delay: 1, async write(batch) {
    const value = batch.get('file')!;
    if (value === 'older') throw new Error('controlled write failure');
    writes.push(value);
  } });
  const recovered = writer.set('file', 'older').catch(() => writer.set('file', 'new typing'));
  await assert.rejects(writer.flush(), /controlled write failure/);
  await recovered;
  assert.deepEqual(writes, ['new typing']);
});
