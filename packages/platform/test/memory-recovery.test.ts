// Recovery of an accepted consolidation, using disposable plain-file homes only. Failures below
// interrupt a durable write before or after its rename; they are not power-loss or full-disk tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import type { MemoryEntry } from '../src/api.ts';
import { createMemory } from '../src/composition/memory.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { judgeStep } from '../src/testing/memory-model.ts';

const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
const live = () => 'current' as const;
const sourceA = { id: 'a', name: 'office-a.md', version: 1 };
const sourceB = { id: 'b', name: 'office-b.md', version: 2 };

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'memory-recovery-'));
  homes.push(home);
  const withdrawn = new Set<string>();
  const open = () => createMemory({
    home, userHome: undefined, threads: new Map(), emit() {}, projectExists: () => false, credentials: async () => [],
    material: { load: (id: string) => ({ withdrawals: withdrawn.has(id) ? [{}] : [] }) } as never,
    locked: (fn) => fn(),
    // Consolidation is a model's judgement; a scripted one merges the two lines that say the same.
    judge: async ({ text }) => (judgeStep([{ role: 'user', content: text }]) as { text: string }).text,
  });
  const store = new MemoryStore(home);
  const a = store.add({ topic: 'office', text: 'The office is in Madrid, on Gran Via.', origin: { kind: 'person' }, sources: [sourceA] }, live)!;
  const b = store.add({ topic: 'office', text: 'Our office is in Madrid, on the Gran Via.', origin: { kind: 'person' }, sources: [sourceB] }, live)!;
  const other = store.add({ topic: 'office', text: 'Plants need water on Mondays.', origin: { kind: 'person' }, sources: [] }, live)!;
  const memory = open();
  await memory.handlers['memory.consolidate']({});
  const view = await memory.handlers['memory.get']({});
  assert.equal(view.proposed.length, 1);
  return { home, open, memory, originals: [a, b], other, proposal: view.proposed[0], withdrawn };
}

async function writes<T>(run: () => T | Promise<T>, interrupt?: { index: number; after: boolean }) {
  const rename = fs.renameSync;
  const paths: string[] = [];
  let injected = false;
  let value: T | undefined;
  let error: unknown;
  fs.renameSync = (from, to) => {
    paths.push(String(to));
    const stop = () => {
      injected = true;
      throw Object.assign(new Error('Synthetic write failure during memory consolidation'), { code: 'ENOSPC' });
    };
    if (interrupt?.index === paths.length && !interrupt.after) stop();
    rename(from, to);
    if (interrupt?.index === paths.length && interrupt.after) stop();
  };
  syncBuiltinESMExports();
  try { value = await run(); } catch (caught) { error = caught; }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  return { paths, injected, value, error };
}

function merged(entries: MemoryEntry[], originals: MemoryEntry[]) {
  return entries.find((entry) => entry.origin.kind === 'merge' && !originals.some((original) => original.id === entry.id));
}

test('accepting a consolidation survives reopening with joined provenance and removes no unrelated line', async () => {
  const f = await fixture();
  const accepted = await f.memory.handlers['memory.proposal.decide']({ id: f.proposal.id, verdict: 'keep' });
  assert.equal(accepted.ok, true);
  const reopened = f.open();
  const view = await reopened.handlers['memory.get']({});
  assert.equal(view.entries.length, 2);
  const entry = merged(view.entries, f.originals)!;
  assert.ok(entry);
  assert.equal(entry.text, f.proposal.text);
  assert.deepEqual(entry.sources, f.proposal.sources);
  assert.ok(view.entries.some((e) => e.id === f.other.id && e.text === f.other.text));
  assert.equal(view.proposed.length, 0);
  assert.equal((await reopened.handlers['memory.proposal.decide']({ id: f.proposal.id, verdict: 'keep' })).ok, false);

  f.withdrawn.add('a');
  reopened.purgeSource('a');
  const after = await f.open().handlers['memory.get']({});
  assert.deepEqual(after.entries.map((e) => e.id), [f.other.id], 'withdrawing either original also removes the merged line after restart');
  for (const path of readdirSync(join(f.home, 'memory', 'daily'))) assert.ok(!readFileSync(join(f.home, 'memory', 'daily', path), 'utf8').includes(f.proposal.text));
});

test('every interrupted consolidation write leaves both originals and their proposal, or the sourced replacement', async (t) => {
  const control = await fixture();
  const trace = await writes(() => control.memory.handlers['memory.proposal.decide']({ id: control.proposal.id, verdict: 'keep' }));
  assert.equal(trace.error, undefined);
  assert.equal(trace.value?.ok, true);
  assert.ok(trace.paths.length > 0);
  for (const [i, path] of trace.paths.entries()) for (const after of [false, true]) {
    await t.test(`${after ? 'after' : 'before'} write ${i + 1}: ${relative(control.home, path)}`, async () => {
      const f = await fixture();
      const result = await writes(() => f.memory.handlers['memory.proposal.decide']({ id: f.proposal.id, verdict: 'keep' }), { index: i + 1, after });
      assert.equal(result.injected, true);
      assert.equal((result.error as NodeJS.ErrnoException)?.code, 'ENOSPC');
      const reopened = f.open();
      const view = await reopened.handlers['memory.get']({});
      assert.ok(view.entries.some((entry) => entry.id === f.other.id && entry.text === f.other.text));
      const replacement = merged(view.entries, f.originals);
      if (replacement) {
        assert.equal(replacement.text, f.proposal.text);
        assert.deepEqual(replacement.sources, f.proposal.sources, 'a replacement never loses the sources of either original');
        if (view.proposed.some((proposal) => proposal.id === f.proposal.id)) {
          const retried = await reopened.handlers['memory.proposal.decide']({ id: f.proposal.id, verdict: 'keep' });
          assert.equal(retried.ok, true, 'a persisted merge is reported truthfully when only proposal cleanup failed');
          if (retried.ok) assert.equal(retried.value?.id, replacement.id, 'retry identifies the same sourced replacement');
          const settled = await f.open().handlers['memory.get']({});
          assert.equal(settled.entries.length, 2, 'retry does not create a second replacement');
          assert.equal(settled.proposed.length, 0);
        }
        f.withdrawn.add('a');
        reopened.purgeSource('a');
        assert.deepEqual((await f.open().handlers['memory.get']({})).entries.map((entry) => entry.id), [f.other.id]);
      } else {
        for (const original of f.originals) assert.ok(view.entries.some((entry) => entry.id === original.id && entry.text === original.text), 'an uncommitted merge retains every original');
        assert.ok(view.proposed.some((proposal) => proposal.id === f.proposal.id), 'a failed keep can still be retried');
        assert.equal((await reopened.handlers['memory.proposal.decide']({ id: f.proposal.id, verdict: 'keep' })).ok, true);
        assert.equal((await f.open().handlers['memory.get']({})).entries.length, 2);
      }
    });
  }
});

test('a person edit made after consolidation was proposed survives a refused keep', async () => {
  const f = await fixture();
  new MemoryStore(f.home).update(f.originals[0].id, 'The office moved to Lisbon.', live);
  const result = await f.memory.handlers['memory.proposal.decide']({ id: f.proposal.id, verdict: 'keep' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'STALE_BASE');
  const view = await f.open().handlers['memory.get']({});
  assert.equal(view.entries.length, 3);
  assert.ok(view.entries.some((entry) => entry.id === f.originals[0].id && entry.text === 'The office moved to Lisbon.'));
});

test('a person edit during the merge staging writes survives and leaves the proposal available', async () => {
  const f = await fixture();
  const path = join(f.home, 'memory', 'topics', 'office.md');
  const rename = fs.renameSync;
  let edited = false;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (edited || !String(to).startsWith(join(f.home, 'memory', 'daily'))) return;
    edited = true;
    const edit = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const [path, id] = process.argv.slice(1);
      const lines = fs.readFileSync(path, 'utf8').split('\\n');
      fs.writeFileSync(path, lines.map(line => line.includes(id) ? '- The office moved to Lisbon. <!-- m:' + id + ' -->' : line).join('\\n'));
    `, path, f.originals[0].id], { encoding: 'utf8' });
    assert.equal(edit.status, 0, edit.stderr);
  };
  syncBuiltinESMExports();
  let result;
  try { result = await f.memory.handlers['memory.proposal.decide']({ id: f.proposal.id, verdict: 'keep' }); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(edited, true);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'STALE_BASE');
  const view = await f.open().handlers['memory.get']({});
  assert.equal(view.entries.length, 3);
  assert.ok(view.entries.some((entry) => entry.id === f.originals[0].id && entry.text === 'The office moved to Lisbon.'));
  assert.ok(view.entries.some((entry) => entry.id === f.originals[1].id && entry.text === f.originals[1].text));
  assert.ok(view.proposed.some((proposal) => proposal.id === f.proposal.id));
  assert.equal(merged(view.entries, f.originals), undefined);
});

test('sources joined to an original after the proposal also belong to the accepted merge', async () => {
  const f = await fixture();
  const later = { id: 'later', name: 'office-later.md', version: 1 };
  new MemoryStore(f.home).add({ ...f.originals[0], sources: [later] }, live);
  // Reopen as normal home ownership does; text stayed unchanged but its provenance grew.
  const reopened = f.open();
  assert.equal((await reopened.handlers['memory.proposal.decide']({ id: f.proposal.id, verdict: 'keep' })).ok, true);
  const entry = merged((await f.open().handlers['memory.get']({})).entries, f.originals)!;
  assert.ok(entry.sources.some((source) => source.id === later.id));
  f.withdrawn.add(later.id);
  reopened.purgeSource(later.id);
  assert.deepEqual((await f.open().handlers['memory.get']({})).entries.map((line) => line.id), [f.other.id]);
});

test('interrupted daily cleanup keeps its record so the same reopened store can retry it', async () => {
  const f = await fixture();
  // A record whose topic line was removed is cleaned from daily notes on read, also after a merge.
  const path = join(f.home, 'memory', 'topics', 'office.md');
  fs.writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter((line) => !line.includes(f.originals[0].id)).join('\n'));
  const reopened = new MemoryStore(f.home);
  const result = await writes(async () => reopened.list(live), { index: 1, after: false });
  assert.equal(result.injected, true);
  assert.equal((result.error as NodeJS.ErrnoException)?.code, 'ENOSPC');
  reopened.list(live);
  for (const file of readdirSync(join(f.home, 'memory', 'daily'))) assert.ok(!readFileSync(join(f.home, 'memory', 'daily', file), 'utf8').includes(f.originals[0].id));
});

test('the same words from a different origin do not count as this proposal already merged', async () => {
  const f = await fixture();
  const store = new MemoryStore(f.home);
  for (const original of f.originals) store.forget(original.id);
  const unrelated = store.add({ topic: f.proposal.topic, text: f.proposal.text, origin: { kind: 'merge' }, sources: [{ id: 'unrelated', name: 'other.md', version: 1 }] }, live)!;
  const reopened = f.open();
  const result = await reopened.handlers['memory.proposal.decide']({ id: f.proposal.id, verdict: 'keep' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'STALE_BASE');
  const view = await reopened.handlers['memory.get']({});
  assert.deepEqual(view.entries.find((entry) => entry.id === unrelated.id)?.sources, unrelated.sources);
  assert.ok(view.proposed.some((proposal) => proposal.id === f.proposal.id));
  assert.ok(!view.entries.some((entry) => entry.id === f.proposal.id));
});
