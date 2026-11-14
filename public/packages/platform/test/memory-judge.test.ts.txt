// Consolidation by a model's judgement, on disposable plain-file homes with a scripted judge (no model
// is called). What an engine learned is merged, superseded, retired or kept by itself, each with its
// sources and an undo; what touches the person's own words, or contradicts them, waits for them,
// whatever the model said. A withdrawn source still takes everything made from it, undo included, and
// an interrupted automatic change loses nothing.
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { MemoryEntry, MemoryView } from '../src/api.ts';
import { createMemory } from '../src/composition/memory.ts';
import { JUDGE_MARK } from '../src/memory/judge.ts';
import { MemoryStore } from '../src/memory/store.ts';

const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
const live = () => 'current' as const;

interface Shown { id: string; topic: string; by: 'person' | 'engine'; text: string }
/** A scripted judge: `decide` names lines and proposals by their words; the handles are looked up here. */
type Decide = (data: { lines: Shown[]; proposed: Shown[] }, h: (words: string) => string) => Record<string, unknown>[] | string | Promise<Record<string, unknown>[] | string>;

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'memory-judge-'));
  homes.push(home);
  const withdrawn = new Set<string>();
  const asked: string[] = [];
  let decide: Decide = () => [];
  const known: string[] = [];
  const open = () => createMemory({
    home, userHome: undefined, threads: new Map(), emit() {}, projectExists: () => false, credentials: async () => [...known],
    material: { load: (id: string) => ({ withdrawals: withdrawn.has(id) ? [{}] : [] }) } as never,
    locked: (fn) => fn(),
    judge: async ({ text }) => {
      asked.push(text);
      const data = JSON.parse(text.slice(text.lastIndexOf('\n{\n') + 1)) as { lines: Shown[]; proposed: Shown[] };
      const h = (words: string) => [...data.lines, ...data.proposed].find((x) => x.text === words)?.id ?? 'none';
      const answer = await decide(data, h);
      return typeof answer === 'string' ? answer : `Here you are:\n${JSON.stringify({ changes: answer })}`;
    },
  });
  const store = new MemoryStore(home);
  const line = (topic: string, text: string, kind: MemoryEntry['origin']['kind'], sources: MemoryEntry['sources'] = []) => store.add({ topic, text, origin: { kind }, sources }, live)!;
  let memory: ReturnType<typeof createMemory> | undefined;
  // Opened once the lines are written, as a host opens a home whose files were written before.
  return { home, open, get memory() { return (memory ??= open()); }, store, line, withdrawn, asked, known, judge: (d: Decide) => { decide = d; } };
}
const view = (m: ReturnType<typeof createMemory>) => m.handlers['memory.get']({}) as Promise<MemoryView>;
const texts = (v: MemoryView) => v.entries.map((e) => e.text).sort();
const src = (id: string) => ({ id, name: `${id}.md`, version: 1 });

test('an engine\'s lines that say the same are deduplicated by the model\'s judgement, with joined sources and an undo that puts them back', async () => {
  const f = fixture();
  f.line('fleet', 'The van is serviced in March.', 'engine', [src('a')]);
  f.line('fleet', 'Service the van every March at the garage.', 'engine', [src('b')]);
  f.line('fleet', 'The garage closes on Sundays.', 'person');
  f.judge((_, h) => [{ op: 'merge', lines: [h('The van is serviced in March.'), h('Service the van every March at the garage.')], text: 'Service the van every March at the garage.', why: 'Same fact.' }]);
  const r = await f.memory.handlers['memory.consolidate']({});
  assert.deepEqual(r.ok && r.value, { proposed: 0, kept: 1 });
  assert.ok(f.asked[0].startsWith(JUDGE_MARK));
  let v = await view(f.memory);
  assert.deepEqual(texts(v), ['Service the van every March at the garage.', 'The garage closes on Sundays.']);
  const merged = v.entries.find((e) => /every March/.test(e.text))!;
  assert.equal(merged.origin.kind, 'engine');
  assert.deepEqual(merged.sources.map((s) => s.id).sort(), ['a', 'b'], 'every source kept');
  assert.equal(v.kept.length, 1);
  assert.deepEqual([v.kept[0].op, v.kept[0].why, v.kept[0].removed.length], ['merge', 'Same fact.', 2]);

  value(await f.memory.handlers['memory.undo']({ id: v.kept[0].id }));
  v = await view(f.memory);
  assert.deepEqual(texts(v), ['Service the van every March at the garage.', 'The garage closes on Sundays.', 'The van is serviced in March.']);
  assert.deepEqual(v.entries.find((e) => e.text === 'The van is serviced in March.')!.sources.map((s) => s.id), ['a'], 'back with its own record');
  assert.equal(v.kept.length, 0);
  assert.equal((await f.memory.handlers['memory.undo']({ id: 'gone' })).ok, false);
});

test('supersede and retire of an engine\'s lines are done; of the person\'s lines they wait, and kept by the person they take the line out', async () => {
  const f = fixture();
  f.line('office', 'The office is on Gran Via.', 'engine');
  f.line('office', 'The office moved to Castellana in October.', 'engine');
  f.line('events', 'The 2025 offsite is in Lisbon.', 'engine');
  f.line('events', 'The 2024 party is on Friday.', 'person');
  f.judge((_, h) => [
    { op: 'supersede', lines: [h('The office is on Gran Via.')], by: h('The office moved to Castellana in October.'), why: 'It moved.' },
    { op: 'retire', lines: [h('The 2025 offsite is in Lisbon.')], why: 'That year is over.' },
    { op: 'retire', lines: [h('The 2024 party is on Friday.')], why: 'That year is over.' },
  ]);
  const r = await f.memory.handlers['memory.consolidate']({});
  assert.deepEqual(r.ok && r.value, { proposed: 1, kept: 2 });
  const v = await view(f.memory);
  assert.deepEqual(texts(v), ['The 2024 party is on Friday.', 'The office moved to Castellana in October.']);
  assert.deepEqual(v.kept.map((c) => c.op).sort(), ['retire', 'supersede']);
  const held = v.proposed[0];
  assert.deepEqual([held.judged?.op, held.text, held.replaces?.map((x) => x.text)], ['retire', '', ['The 2024 party is on Friday.']]);
  // Not judged twice while it waits.
  f.line('events', 'The 2026 offsite is in Porto.', 'engine');
  f.judge(() => []);
  await f.memory.handlers['memory.consolidate']({});
  assert.equal(f.asked.length, 2);
  assert.ok(!f.asked[1].includes('The 2024 party'), 'a line in a waiting change is not shown again');
  const kept = await f.memory.handlers['memory.proposal.decide']({ id: held.id, verdict: 'keep' });
  assert.deepEqual(kept, { ok: true, value: null });
  assert.deepEqual(texts(await view(f.memory)), ['The 2026 offsite is in Porto.', 'The office moved to Castellana in October.']);
});

test('a merge that takes out the person\'s words, or a change the model says contradicts them, waits for the person', async () => {
  const f = fixture();
  f.line('billing', 'Invoices go out on the first Monday.', 'person');
  f.line('billing', 'Invoices are sent on the first Monday of the month.', 'engine');
  f.line('billing', 'ACME pays by transfer.', 'engine');
  f.line('billing', 'ACME pays by bank transfer within 30 days.', 'engine');
  f.line('billing', 'ACME pays by card.', 'person');
  f.judge((_, h) => [
    { op: 'merge', lines: [h('Invoices go out on the first Monday.'), h('Invoices are sent on the first Monday of the month.')], text: 'Invoices go out on the first Monday of the month.', why: 'Same.' },
    { op: 'merge', lines: [h('ACME pays by transfer.'), h('ACME pays by bank transfer within 30 days.')], text: 'ACME pays by bank transfer within 30 days.', conflicts: [h('ACME pays by card.')], why: 'Same, but the person said card.' },
  ]);
  const r = await f.memory.handlers['memory.consolidate']({});
  assert.deepEqual(r.ok && r.value, { proposed: 2, kept: 0 });
  const v = await view(f.memory);
  assert.equal(v.entries.length, 5, 'nothing changed by itself');
  const conflict = v.proposed.find((p) => /30 days/.test(p.text))!;
  assert.deepEqual(conflict.judged?.conflicts.map((c) => c.text), ['ACME pays by card.']);
});

test('an engine\'s proposal is kept by itself unless the model holds it, or names the person\'s line it contradicts', async () => {
  const f = fixture();
  f.line('team', 'Ana leads the design team.', 'person');
  const waiting: MemoryEntry[] = ['Luis joined the team in May.', 'Ana left the design team.', 'Marta runs payroll.'].map((text) => ({ id: crypto.randomUUID(), topic: 'team', text, origin: { kind: 'engine', threadId: 't', turnId: 'u' }, sources: [src('doc')], at: new Date().toISOString() }));
  fs.writeFileSync(join(f.home, 'memory', '.proposed.json'), JSON.stringify(waiting));
  f.judge((_, h) => [
    { op: 'keep', proposal: h('Luis joined the team in May.'), why: 'New.' },
    { op: 'keep', proposal: h('Ana left the design team.'), conflicts: [h('Ana leads the design team.')], why: 'Contradicts the person.' },
    // Marta's line is not mentioned: it stays held, never kept by default.
  ]);
  const r = await f.memory.handlers['memory.consolidate']({});
  assert.deepEqual(r.ok && r.value, { proposed: 1, kept: 1 });
  const v = await view(f.memory);
  assert.deepEqual(texts(v), ['Ana leads the design team.', 'Luis joined the team in May.']);
  const luis = v.entries.find((e) => /Luis/.test(e.text))!;
  assert.deepEqual([luis.origin.kind, luis.sources.map((s) => s.id)], ['engine', ['doc']]);
  assert.deepEqual(v.proposed.map((p) => [p.text, p.judged?.op ?? null]).sort(), [['Ana left the design team.', 'hold'], ['Marta runs payroll.', null]]);
  // Kept by the person, a held line is theirs: no later pass changes it by itself.
  const kept = value(await f.memory.handlers['memory.proposal.decide']({ id: v.proposed.find((p) => /Ana/.test(p.text))!.id, verdict: 'keep' }));
  assert.equal(kept!.origin.kind, 'turn');
});

test('withdrawing a source takes what was made from it, and its undo cannot bring it back', async () => {
  const f = fixture();
  f.line('fleet', 'The van is serviced in March.', 'engine', [src('a')]);
  f.line('fleet', 'Service the van every March.', 'engine', [src('b')]);
  f.judge((_, h) => [{ op: 'merge', lines: [h('The van is serviced in March.'), h('Service the van every March.')], text: 'Service the van every March.', why: 'Same.' }]);
  await f.memory.handlers['memory.consolidate']({});
  f.withdrawn.add('a');
  f.memory.purgeSource('a');
  const v = await view(f.memory);
  assert.equal(v.entries.length, 0, 'the merged line carried both sources');
  assert.deepEqual(v.kept[0].removed.map((e) => e.text), ['Service the van every March.'], 'the line from a is gone from the undo');
  value(await f.memory.handlers['memory.undo']({ id: v.kept[0].id }));
  assert.deepEqual(texts(await view(f.memory)), ['Service the van every March.']);
  f.withdrawn.add('b');
  f.memory.purgeSource('b');
  const after = await view(f.memory);
  assert.deepEqual([after.entries.length, after.kept.length], [0, 0]);
});

test('with no model, or an answer that does not hold together, nothing changes', async () => {
  const f = fixture();
  f.line('fleet', 'The van is serviced in March.', 'engine');
  f.line('fleet', 'Service the van every March.', 'engine');
  f.line('other', 'Plants need water.', 'engine');
  for (const answer of ['not json', '{"changes":[{"op":"merge","lines":["L1","L9"],"text":"x"}]}', '{"changes":[{"op":"merge","lines":["L1","L3"],"text":"across topics"}]}', '{"changes":[{"op":"delete","lines":["L1"]}]}', '{"changes":[{"op":"merge","lines":["L1","L2"],"text":"The key is sk-live-0123456789abcdefABCDEF"}]}']) { // public-tree: synthetic
    f.judge(() => answer);
    const r = await f.memory.handlers['memory.consolidate']({});
    assert.deepEqual(r.ok && r.value, { proposed: 0, kept: 0 }, answer);
  }
  const bare = createMemory({ home: f.home, userHome: undefined, threads: new Map(), emit() {}, projectExists: () => false, credentials: async () => [], material: { load: () => ({}) } as never });
  assert.deepEqual(value(await bare.handlers['memory.consolidate']({})), { proposed: 0, kept: 0 });
  assert.equal((await view(f.memory)).entries.length, 3);
});

test('an automatic merge interrupted at any write leaves both lines, or the merged line with its undo', async () => {
  // Count the writes of an uninterrupted run, then interrupt each one in turn, before and after its rename.
  const count = async () => {
    const f = fixture();
    f.line('fleet', 'The van is serviced in March.', 'engine', [src('a')]);
    f.line('fleet', 'Service the van every March.', 'engine', [src('b')]);
    f.judge((_, h) => [{ op: 'merge', lines: [h('The van is serviced in March.'), h('Service the van every March.')], text: 'Service the van every March.', why: 'Same.' }]);
    return f;
  };
  const rename = fs.renameSync;
  let n = 0;
  fs.renameSync = (a, b) => { n++; rename(a, b); };
  syncBuiltinESMExports();
  const control = await count();
  n = 0;
  try { await control.memory.handlers['memory.consolidate']({}); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  const total = n;
  assert.ok(total >= 3);
  for (let i = 1; i <= total; i++) for (const afterRename of [false, true]) {
    const f = await count();
    let seen = 0;
    fs.renameSync = (a, b) => {
      seen++;
      if (seen === i && !afterRename) throw Object.assign(new Error('Synthetic write failure'), { code: 'ENOSPC' });
      rename(a, b);
      if (seen === i && afterRename) throw Object.assign(new Error('Synthetic write failure'), { code: 'ENOSPC' });
    };
    syncBuiltinESMExports();
    try { await f.memory.handlers['memory.consolidate']({}); } catch { /* interrupted */ } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    const reopened = f.open();
    const v = await view(reopened);
    const both = ['Service the van every March.', 'The van is serviced in March.'];
    const label = `write ${i} ${afterRename ? 'after' : 'before'} rename`;
    if (v.entries.length === 1) {
      assert.deepEqual(texts(v), ['Service the van every March.'], label);
      assert.deepEqual(v.kept[0]?.removed.map((e) => e.text).sort(), both, `${label}: the undo holds both originals`);
      value(await reopened.handlers['memory.undo']({ id: v.kept[0].id }));
      assert.deepEqual(texts(await view(reopened)), both, label);
    } else {
      assert.deepEqual(texts(v), both, label);
    }
  }
});

const merge = (a: string, b: string, text: string, why = 'Same.'): Decide => (_, h) => [{ op: 'merge', lines: [h(a), h(b)], text, why }];
const filesUnder = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => readFileSync(join(d.parentPath, d.name), 'utf8')).join('\n');
/** A value the host's store holds, made per run. */
const canary = () => `canary-${crypto.randomUUID()}`;

test('review 2: a line the person edited is theirs, through memory.put or the Markdown, and is never retired by itself', async () => {
  const f = fixture();
  const a = f.line('fleet', 'The van is serviced in March.', 'engine');
  const b = f.line('fleet', 'The truck is serviced in May.', 'engine');
  f.line('fleet', 'Tyres are checked weekly.', 'engine');
  value(await f.memory.handlers['memory.put']({ id: a.id, topic: 'fleet', text: 'The van is serviced in April.' }));
  const path = join(f.home, 'memory', 'topics', 'fleet.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('The truck is serviced in May.', 'The truck is serviced in June.'));
  f.judge((_, h) => [
    { op: 'retire', lines: [h('The van is serviced in April.')], why: 'Stale.' },
    { op: 'retire', lines: [h('The truck is serviced in June.')], why: 'Stale.' },
  ]);
  const r = await f.memory.handlers['memory.consolidate']({});
  assert.deepEqual(r.ok && r.value, { proposed: 2, kept: 0 });
  const v = await view(f.memory);
  assert.ok(v.entries.some((e) => e.text === 'The van is serviced in April.' && e.origin.kind === 'person'));
  assert.ok(v.entries.some((e) => e.id === b.id && e.text === 'The truck is serviced in June.' && e.origin.kind === 'person'));
});

test('review 3: a keep interrupted at any write never leaves a line without its sources', async () => {
  const proposal = (): MemoryEntry => ({ id: crypto.randomUUID(), topic: 'clients', text: 'ACME pays in euros.', origin: { kind: 'engine', threadId: 't', turnId: 'u' }, sources: [src('doc')], at: new Date().toISOString() });
  const rename = fs.renameSync;
  for (let i = 1; i <= 8; i++) for (const afterRename of [false, true]) {
    const f = fixture();
    fs.writeFileSync(join(f.home, 'memory', '.proposed.json'), JSON.stringify([proposal()]));
    f.judge((_, h) => [{ op: 'keep', proposal: h('ACME pays in euros.'), why: 'New.' }]);
    let seen = 0;
    fs.renameSync = (x, y) => {
      seen++;
      if (seen === i && !afterRename) throw Object.assign(new Error('Synthetic write failure'), { code: 'ENOSPC' });
      rename(x, y);
      if (seen === i && afterRename) throw Object.assign(new Error('Synthetic write failure'), { code: 'ENOSPC' });
    };
    syncBuiltinESMExports();
    try { await f.memory.handlers['memory.consolidate']({}); } catch { /* interrupted */ } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    const reopened = f.open();
    const label = `write ${i} ${afterRename ? 'after' : 'before'} rename`;
    for (const e of (await view(reopened)).entries) assert.deepEqual([e.origin.kind, e.sources.map((s) => s.id)], ['engine', ['doc']], label);
    f.withdrawn.add('doc');
    reopened.purgeSource('doc');
    const after = await view(reopened);
    assert.deepEqual([after.entries.length, after.proposed.length], [0, 0], label);
  }
});

test('round 2, 1: only a verbatim dedupe is done by itself; a merge with any other words waits, however close its words', async () => {
  const f = fixture();
  f.line('offset', 'The offset is 10 and 20.', 'engine', [src('a')]);
  f.line('offset', 'The offset uses 10 or 20.', 'engine', [src('b')]);
  f.line('other', 'The offset is -10.20.', 'engine', [src('c')]);
  f.judge(merge('The offset is 10 and 20.', 'The offset uses 10 or 20.', 'The offset is -10.20.'));
  const r = await f.memory.handlers['memory.consolidate']({});
  assert.deepEqual(r.ok && r.value, { proposed: 1, kept: 0 });
  const v = await view(f.memory);
  assert.equal(v.entries.length, 3, 'nothing changed by itself');
  assert.deepEqual(v.proposed[0].sources.map((x) => x.id).sort(), ['a', 'b', 'c'], 'it carries everything the pass showed');
  // Withdrawing what it may have copied takes the waiting change away.
  f.withdrawn.add('c');
  f.memory.purgeSource('c');
  assert.equal((await view(f.memory)).proposed.length, 0);
  assert.ok(!readFileSync(join(f.home, 'memory', '.proposed.json'), 'utf8').includes('-10.20'));
});

test('review 5: reading memory never erases an undo record that is being written', async () => {
  const f = fixture();
  const a = f.line('fleet', 'The van is serviced in March.', 'engine');
  // As a pass leaves it between its undo record and its topic write: the replacement not yet there.
  const staged = [{ id: 'c1', at: new Date().toISOString(), op: 'merge', why: 'Same.', added: { id: crypto.randomUUID(), topic: 'fleet', text: 'Merged.' }, removed: [a], sources: [] }];
  const path = join(f.home, 'memory', '.changes.json');
  writeFileSync(path, JSON.stringify(staged));
  const before = readFileSync(path, 'utf8');
  await view(f.memory);
  await f.memory.handlers['memory.search']({ query: 'van' });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('review 6: a credential in the model\'s reason is never kept or shown', async () => {
  const f = fixture();
  const secret = canary();
  f.known.push(secret);
  f.line('fleet', 'The van is serviced in March.', 'engine');
  f.line('fleet', 'Service the van every March.', 'engine');
  f.line('notes', 'Ana leads design.', 'person');
  f.line('notes', 'Ana leads the design team.', 'person');
  f.judge((_, h) => [
    { op: 'merge', lines: [h('The van is serviced in March.'), h('Service the van every March.')], text: 'Service the van every March.', why: `Same, see ${secret}.` },
    { op: 'merge', lines: [h('Ana leads design.'), h('Ana leads the design team.')], text: 'Ana leads the design team.', why: `Same, see ${secret}.` },
  ]);
  const r = await f.memory.handlers['memory.consolidate']({});
  assert.deepEqual(r.ok && r.value, { proposed: 1, kept: 1 });
  assert.ok(!filesUnder(join(f.home, 'memory')).includes(secret));
  assert.ok(!JSON.stringify(await view(f.memory)).includes(secret));
});

test('review 7: undo never writes back words that are a credential now', async () => {
  const f = fixture();
  const value_ = canary();
  f.line('fleet', `The garage gate opens with ${value_}.`, 'engine');
  f.line('fleet', 'The garage gate opens with a code.', 'engine');
  f.judge(merge(`The garage gate opens with ${value_}.`, 'The garage gate opens with a code.', 'The garage gate opens with a code.'));
  await f.memory.handlers['memory.consolidate']({});
  const change = (await view(f.memory)).kept[0];
  f.known.push(value_);
  const r = await f.memory.handlers['memory.undo']({ id: change.id });
  assert.equal(r.ok, false);
  assert.ok(!readFileSync(join(f.home, 'memory', 'topics', 'fleet.md'), 'utf8').includes(value_));
});

test('review 8: once its replacement is withdrawn, its words leave the undo record and the view', async () => {
  const f = fixture();
  f.line('fleet', 'The van is serviced in March.', 'engine', [src('a')]);
  f.line('fleet', 'Service the van every March, at the garage.', 'engine', [src('b')]);
  f.judge(merge('The van is serviced in March.', 'Service the van every March, at the garage.', 'Service the van every March, at the garage.'));
  await f.memory.handlers['memory.consolidate']({});
  f.withdrawn.add('a');
  f.memory.purgeSource('a');
  assert.ok(!readFileSync(join(f.home, 'memory', '.changes.json'), 'utf8').includes('serviced in March'));
  const v = await view(f.memory);
  assert.equal(v.kept[0].added, null);
  assert.ok(!JSON.stringify(v).includes('serviced in March'));
});

test('round 2, 2: a reason or snapshot depends on everything the pass showed; withdrawing any of it redacts or removes it', async () => {
  const f = fixture();
  f.line('fleet', 'The van is serviced in March.', 'engine', [src('a')]);
  f.line('fleet', 'Service the van every March.', 'engine', [src('b')]);
  f.line('vault', 'The vault opens on Fridays.', 'engine', [src('c')]);
  f.line('office', 'The office is on Gran Via.', 'person');
  f.line('office', 'The office moved to Castellana.', 'engine', [src('d')]);
  f.judge((_, h) => [
    { op: 'merge', lines: [h('The van is serviced in March.'), h('Service the van every March.')], text: 'Service the van every March.', why: 'Same; also the vault opens on Fridays.' },
    { op: 'supersede', lines: [h('The office is on Gran Via.')], by: h('The office moved to Castellana.'), why: 'Moved.' },
  ]);
  assert.deepEqual(value(await f.memory.handlers['memory.consolidate']({})), { proposed: 1, kept: 1 });
  f.withdrawn.add('c');
  f.memory.purgeSource('c');
  let v = await view(f.memory);
  assert.ok(!JSON.stringify(v).includes('opens on Fridays'), 'the reason is redacted');
  assert.ok(!readFileSync(join(f.home, 'memory', '.changes.json'), 'utf8').includes('opens on Fridays'));
  assert.equal(v.kept.length, 1, 'its undo stays');
  assert.equal(v.proposed.length, 0, 'a waiting change that depended on it is gone');
  v = await view(f.memory);
  assert.ok(!readFileSync(join(f.home, 'memory', '.proposed.json'), 'utf8').includes('Castellana'));
});

test('round 2, 3: a withdrawal that completes while the model is judging keeps the pass from saving anything', async () => {
  const f = fixture();
  f.line('fleet', 'The van is serviced in March.', 'engine', [src('a')]);
  f.line('fleet', 'Service the van every March.', 'engine', [src('b')]);
  f.line('vault', 'The vault code is -10.20.', 'engine', [src('c')]);
  let memory: ReturnType<typeof createMemory>;
  f.judge((_, h) => {
    f.withdrawn.add('c');
    memory.purgeSource('c');
    return [{ op: 'merge', lines: [h('The van is serviced in March.'), h('Service the van every March.')], text: 'The vault code is -10.20.', why: 'Same.' }];
  });
  memory = f.memory;
  assert.deepEqual(value(await memory.handlers['memory.consolidate']({})), { proposed: 0, kept: 0 });
  assert.ok(!filesUnder(join(f.home, 'memory')).includes('-10.20'));
});

test('round 2, 4: withdrawing the source of a line kept by itself takes its words out of the undo record', async () => {
  const f = fixture();
  fs.writeFileSync(join(f.home, 'memory', '.proposed.json'), JSON.stringify([{ id: crypto.randomUUID(), topic: 'clients', text: 'ACME pays in euros.', origin: { kind: 'engine', threadId: 't', turnId: 'u' }, sources: [src('doc')], at: new Date().toISOString() }]));
  f.line('clients', 'Beta pays in dollars.', 'engine');
  f.judge((_, h) => [{ op: 'keep', proposal: h('ACME pays in euros.'), why: 'New.' }]);
  assert.deepEqual(value(await f.memory.handlers['memory.consolidate']({})), { proposed: 0, kept: 1 });
  f.withdrawn.add('doc');
  f.memory.purgeSource('doc');
  assert.ok(!filesUnder(join(f.home, 'memory')).includes('ACME pays in euros'));
});

test('round 3, 2: a value that becomes a credential while the model judges is copied into no undo record or held change', async () => {
  const f = fixture();
  const secret = canary();
  f.line('vault', `The vault opens with ${secret}.`, 'engine');
  f.line('vault', `Ask Ana before using ${secret}.`, 'person');
  f.line('vault', 'The vault is in the basement.', 'engine');
  f.judge((_, h) => {
    f.known.push(secret);
    return [
      { op: 'retire', lines: [h(`The vault opens with ${secret}.`)], why: 'Stale.' },
      { op: 'retire', lines: [h(`Ask Ana before using ${secret}.`)], why: 'Stale.' },
      { op: 'retire', lines: [h('The vault is in the basement.')], conflicts: [h(`Ask Ana before using ${secret}.`)], why: 'Stale.' },
    ];
  });
  assert.deepEqual(value(await f.memory.handlers['memory.consolidate']({})), { proposed: 0, kept: 0 });
  for (const name of ['.changes.json', '.proposed.json']) {
    const path = join(f.home, 'memory', name);
    assert.ok(!(fs.existsSync(path) && readFileSync(path, 'utf8').includes(secret)), name);
  }
});

test('round 3, 3: the person keeping a proposal that is already a line makes that line theirs', async () => {
  const f = fixture();
  f.line('clients', 'ACME pays in euros.', 'engine', [src('doc')]);
  f.line('clients', 'Beta pays in dollars.', 'engine');
  const id = crypto.randomUUID();
  fs.writeFileSync(join(f.home, 'memory', '.proposed.json'), JSON.stringify([{ id, topic: 'clients', text: 'ACME pays in euros.', origin: { kind: 'engine', threadId: 't', turnId: 'u' }, sources: [src('doc')], at: new Date().toISOString() }]));
  const kept = value(await f.memory.handlers['memory.proposal.decide']({ id, verdict: 'keep' }));
  assert.notEqual(kept!.origin.kind, 'engine');
  f.judge((_, h) => [{ op: 'retire', lines: [h('ACME pays in euros.')], why: 'Stale.' }]);
  assert.deepEqual(value(await f.memory.handlers['memory.consolidate']({})), { proposed: 1, kept: 0 });
  assert.ok((await view(f.memory)).entries.some((e) => e.text === 'ACME pays in euros.'));
});

test('round 4, 3: a source name that becomes a credential while the model judges keeps the pass from saving anything', async () => {
  const f = fixture();
  const secret = canary();
  f.line('fleet', 'The van is serviced in March.', 'engine', [{ id: 'a', name: `notes-${secret}.md`, version: 1 }]);
  f.line('fleet', 'The garage is on Calle Mayor.', 'engine');
  f.judge((_, h) => {
    f.known.push(secret);
    return [{ op: 'retire', lines: [h('The van is serviced in March.')], why: 'Stale.' }, { op: 'retire', lines: [h('The garage is on Calle Mayor.')], why: 'Stale.' }];
  });
  assert.deepEqual(value(await f.memory.handlers['memory.consolidate']({})), { proposed: 0, kept: 0 });
  for (const name of ['.changes.json', '.proposed.json']) {
    const path = join(f.home, 'memory', name);
    assert.ok(!(fs.existsSync(path) && readFileSync(path, 'utf8').includes(secret)), name);
  }
});

test('round 5, 1: a credential-bearing source name is not masked by a later clean name for the same source', async () => {
  const f = fixture();
  const secret = canary();
  f.line('fleet', 'The van is serviced in March.', 'engine', [{ id: 's', name: `notes-${secret}.md`, version: 1 }]);
  f.line('fleet', 'The garage is on Calle Mayor.', 'engine', [{ id: 's', name: 'notes.md', version: 1 }]);
  f.judge((_, h) => {
    f.known.push(secret);
    return [{ op: 'retire', lines: [h('The van is serviced in March.')], why: 'Stale.' }];
  });
  assert.deepEqual(value(await f.memory.handlers['memory.consolidate']({})), { proposed: 0, kept: 0 });
  for (const name of ['.changes.json', '.proposed.json']) {
    const path = join(f.home, 'memory', name);
    assert.ok(!(fs.existsSync(path) && readFileSync(path, 'utf8').includes(secret)), name);
  }
});

test('round 5, 2: sources a line gained while the model judged are checked at save time too', async () => {
  const f = fixture();
  const secret = canary();
  f.line('fleet', 'The van is serviced in March.', 'engine');
  f.line('fleet', 'The garage is on Calle Mayor.', 'engine');
  const id = crypto.randomUUID();
  fs.writeFileSync(join(f.home, 'memory', '.proposed.json'), JSON.stringify([{ id, topic: 'fleet', text: 'The van is serviced in March.', origin: { kind: 'engine', threadId: 't', turnId: 'u' }, sources: [{ id: 'x', name: `notes-${secret}.md`, version: 1 }], at: new Date().toISOString(), judged: { op: 'hold', why: 'Waits.', conflicts: [] } }]));
  f.judge(async (_, h) => {
    // While the model judges, the person keeps the waiting line: the existing line gains its source.
    value(await f.memory.handlers['memory.proposal.decide']({ id, verdict: 'keep' }));
    f.known.push(secret);
    return [{ op: 'retire', lines: [h('The van is serviced in March.')], why: 'Stale.' }, { op: 'retire', lines: [h('The garage is on Calle Mayor.')], why: 'Stale.' }];
  });
  const r = value(await f.memory.handlers['memory.consolidate']({}));
  assert.equal(r.kept, 1, 'the clean line is still retired');
  for (const name of ['.changes.json', '.proposed.json']) {
    const path = join(f.home, 'memory', name);
    assert.ok(!(fs.existsSync(path) && readFileSync(path, 'utf8').includes(secret)), name);
  }
});

test('a pass that starts or resumes after its host closed takes no lock and writes nothing', async () => {
  const f = fixture();
  f.line('fleet', 'The van is serviced in March.', 'engine');
  f.line('fleet', 'Service the van every March.', 'engine');
  let closed = false;
  let locks = 0;
  let judged = 0;
  const memory = createMemory({
    home: f.home, userHome: undefined, threads: new Map(), emit() {}, projectExists: () => false,
    // The credentials resolve after the host has closed, as a slow vault read can.
    credentials: async () => { closed = true; return []; },
    material: { load: () => ({ withdrawals: [] }) } as never,
    locked: (fn) => { locks++; return fn(); },
    closing: () => closed,
    judge: async () => { judged++; return '{"changes":[]}'; },
  });
  await memory.daily();
  assert.deepEqual([locks, judged], [0, 0]);
});

function value<T>(r: { ok: true; value: T } | { ok: false; detail: string } | T): T {
  if (r && typeof r === 'object' && 'ok' in r) { if (!r.ok) throw new Error((r as { detail: string }).detail); return (r as { value: T }).value; }
  return r as T;
}
