import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Skill, Turn } from '../src/api.ts';
import { createMemory } from '../src/composition/memory.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../src/composition/home-lock.ts';
import { narrowest, narrowSettings } from '../src/composition/parallel-work.ts';
import { acceptDraft, draftSkill } from '../src/memory/imports.ts';
import { decideEdit, proposeEdit } from '../src/memory/skill-learning.ts';
import { MemoryStore } from '../src/memory/store.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { freshHome, settings, value } from './helpers.ts';

function fixture() {
  const home = freshHome(), withdrawn = new Set<string>();
  let credentials: string[] = [], credentialReads = 0;
  const threads = new Map<string, StoredThread>();
  const memory = createMemory({ home, userHome: undefined, threads, emit() {}, projectExists: () => true,
    credentials: async () => { credentialReads++; return credentials; }, locked: fn => withHomeLock(home, fn),
    material: { load: (id: string) => ({ withdrawals: withdrawn.has(id) ? [{}] : [] }) } as never });
  const state = (id: string) => withdrawn.has(id) ? 'withdrawn' as const : 'current' as const;
  const draft = (sources = [{ id: 'source', name: 'evidence.md', version: 1 }]) => draftSkill(home, { threadId: 'chat', turnId: 'turn', title: 'Weekly report', request: 'Prepare weekly report', steps: ['Read evidence'], answer: 'Report ready', sources }, []);
  const view = () => memory.handlers['memory.get']({});
  const listed = async (s: Skill) => (await view()).skills.find(x => x.id === s.id)!;
  return { home, threads, memory, state, get credentialReads() { return credentialReads; }, withdrawn, draft, view, listed, credentials: (values: string[]) => { credentials = values; } };
}

test('memory off skips recall and learning while a normal task still remembers', async () => {
  const f = fixture(), store = new MemoryStore(f.home);
  store.add({ topic: 'reports', text: 'Weekly reports are private.', origin: { kind: 'person' }, sources: [] }, f.state);
  const off = { ...settings, memory: 'off' as const };
  assert.equal(f.credentialReads, 0);
  const recall = await f.memory.forTurn('p', 'weekly reports', off);
  assert.deepEqual(recall!.recall(), { instructions: '', text: '', sources: [], record: { off: true, used: [], instructions: false, skills: [], remembered: [] } });
  assert.equal(f.credentialReads, 0);
  assert.equal(recall!.search, undefined); assert.equal(recall!.propose, undefined);
  const turn: Turn = { id: 'turn', side: false, status: 'done', user: { text: 'Remember that my release is Friday.', attachments: [], settings: off, at: 'now' }, work: { startedAt: 'now', harness: 'test', steps: [] }, answer: { text: 'Done', files: [] }, effects: [] };
  const thread = { summary: { id: 'chat', projectId: 'p' }, turns: [turn], clientKeys: ['key'] } as StoredThread;
  await f.memory.learn(thread, turn);
  assert.equal(store.list(f.state).length, 1);
  turn.user.settings = settings;
  await f.memory.learn(thread, turn);
  assert.equal(store.list(f.state).length, 2);
  assert.match((await f.memory.forTurn('p', 'weekly reports'))!.recall().text, /private/);
});

test('children cannot turn task memory back on', () => {
  const off = { ...settings, memory: 'off' as const };
  assert.equal('settings' in narrowSettings(off, {}, 'worker') && (narrowSettings(off, {}, 'worker') as { settings: typeof off }).settings.memory, 'off');
  assert.equal(narrowest(settings, off)?.memory, 'off');
});

test('a person edits a draft with its source turn, accepts, edits and undoes the edit and removal', async () => {
  const f = fixture(), drafted = await f.listed(f.draft());
  assert.deepEqual(drafted.sourceTurns, [{ threadId: 'chat', turnId: 'turn' }]);
  const revised = value(await f.memory.handlers['skills.put']({ id: drafted.id, base: drafted.revision!, text: drafted.body! + '\nCheck totals twice.\n' }));
  assert.equal(revised.state, 'proposed');
  const active = value(await f.memory.handlers['skills.decide']({ id: drafted.id, verdict: 'accept' }))!;
  const before = readFileSync(active.path, 'utf8');
  const edit = value(await f.memory.handlers['skills.put']({ id: active.id, base: (await f.listed(active)).revision!, text: before + '\nCheck dates too.\n' }));
  assert.match(edit.body!, /dates/);
  const change = (await f.view()).skillChanges!.at(-1)!;
  value(await f.memory.handlers['skills.undo']({ id: change.id }));
  assert.equal(readFileSync(active.path, 'utf8'), before);
  value(await f.memory.handlers['skills.remove']({ id: active.id, base: (await f.listed(active)).revision! }));
  assert.equal((await f.listed(active)), undefined);
  value(await f.memory.handlers['skills.undo']({ id: (await f.view()).skillChanges!.at(-1)!.id }));
  assert.equal(readFileSync(active.path, 'utf8'), before);
  assert.deepEqual((await f.listed(active)).sourceTurns, drafted.sourceTurns);
});

test('undo and stale saves preserve later human edits and withdrawn snapshots never return', async () => {
  const f = fixture(), d = f.draft(); acceptDraft(f.home, d.name);
  let s = (await f.view()).skills.find(x => x.state === 'active')!;
  const base = s.revision!;
  value(await f.memory.handlers['skills.put']({ id: s.id, base, text: s.body! + '\nCheck totals.\n' }));
  const change = (await f.view()).skillChanges!.at(-1)!;
  const outside = readFileSync(s.path, 'utf8') + '\nA later human edit.\n';
  assertHomeWriteAdmission(f.home, dirname(s.path)); writeFileSync(s.path, outside);
  const undo = await f.memory.handlers['skills.undo']({ id: change.id });
  assert.equal(undo.ok, false); if (!undo.ok) assert.equal(undo.reason, 'STALE_BASE');
  assert.equal((await f.memory.handlers['skills.put']({ id: s.id, base, text: 'lost' })).ok, false);
  assert.equal(readFileSync(s.path, 'utf8'), outside);
  f.withdrawn.add('source'); f.memory.purgeSource('source');
  assert.equal((await f.view()).skillChanges!.length, 0);
  assert.equal((await f.memory.handlers['skills.undo']({ id: change.id })).ok, false);
  assert.doesNotMatch(readFileSync(join(f.home, 'skills', '.history.json'), 'utf8'), /Check totals/);
});

test('accepted correction edits have an undo, and current credentials refuse restoring an old snapshot', async () => {
  const f = fixture(), d = f.draft(); acceptDraft(f.home, d.name);
  const original = (await f.view()).skills.find(x => x.state === 'active')!;
  const proposed = proposeEdit(f.home, undefined, f.state, { name: d.name, threadId: 'chat', corrections: ['Check totals.'], sources: [] }, [])!;
  const { found } = await import('../src/memory/imports.ts');
  assert.equal(decideEdit(f.home, undefined, f.state, found(f.home, undefined, f.state).find(x => x.id === proposed.id)!, 'accept', []).ok, true);
  const change = (await f.view()).skillChanges!.at(-1)!;
  f.credentials(['Read evidence']);
  assert.equal((await f.memory.handlers['skills.undo']({ id: change.id })).ok, false);
  f.credentials([]);
  value(await f.memory.handlers['skills.undo']({ id: change.id }));
  assert.equal(readFileSync(original.path, 'utf8'), original.body);
});


test('a credential learned after drafting withholds the body and refuses acceptance', async () => {
  const f = fixture(), d = f.draft();
  f.credentials(['Read evidence']);
  const shown = await f.listed(d);
  assert.equal(shown.body, undefined); assert.equal(shown.revision, undefined);
  assert.equal((await f.memory.handlers['skills.decide']({ id: d.id, verdict: 'accept' })).ok, false);
  f.credentials([]);
  assert.equal((await f.listed(d)).state, 'proposed');
});

// The second process stands in for an editor that does not cooperate with the app's lock.
async function editDuringStage<T>(home: string, skill: Skill, stagedFile: string, run: () => T | Promise<T>) {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { spawnSync } = await import('node:child_process');
  const rename = fs.renameSync;
  let edited = false;
  const text = readFileSync(skill.path, 'utf8') + '\nA concurrent human revision.\n';
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (edited || String(to) !== join(home, 'skills', stagedFile)) return;
    edited = true;
    const edit = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      import { dirname } from 'node:path';
      import { assertHomeWriteAdmission } from ${JSON.stringify(new URL('../src/composition/home-lock.ts', import.meta.url).href)};
      assertHomeWriteAdmission(process.argv[1], dirname(process.argv[2]));
      writeFileSync(process.argv[2], process.argv[3]);
    `, home, skill.path, text], { encoding: 'utf8' });
    assert.equal(edit.status, 0, edit.stderr);
  };
  syncBuiltinESMExports();
  try { const result = await run(); assert.equal(edited, true); return { result, text }; }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
}

for (const action of ['edit', 'remove', 'correction'] as const) test(`a separate-process edit during ${action} staging preserves the human revision`, async () => {
  const f = fixture(), d = f.draft(); acceptDraft(f.home, d.name);
  const s = (await f.view()).skills.find(x => x.state === 'active')!;
  const proposed = action === 'correction' ? proposeEdit(f.home, undefined, f.state, { name: d.name, threadId: 'chat', corrections: ['Check totals'], sources: [] }, []) : null;
  const { found } = await import('../src/memory/imports.ts');
  const { result, text } = await editDuringStage(f.home, s, '.history.json', () => action === 'edit'
    ? f.memory.handlers['skills.put']({ id: s.id, base: s.revision!, text: s.body! + '\nCheck dates.\n' })
    : action === 'remove' ? f.memory.handlers['skills.remove']({ id: s.id, base: s.revision! })
    : decideEdit(f.home, undefined, f.state, found(f.home, undefined, f.state).find(x => x.id === proposed!.id)!, 'accept', []));
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'STALE_BASE');
  assert.equal(readFileSync(s.path, 'utf8'), text);
});

test('a failed draft restores its prior source-turn attribution before its name is reused', async () => {
  const f = fixture();
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('/.proposed/weekly-report/SKILL.md')) throw new Error('Synthetic draft failure');
    rename(from, to);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => f.draft(), /Synthetic draft failure/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  const d = draftSkill(f.home, { threadId: 'other-chat', turnId: 'other-turn', title: 'Weekly report', request: 'Prepare weekly report', answer: 'Done', steps: [], sources: [] }, []);
  assert.equal(d.name, 'weekly-report');
  assert.deepEqual((await f.listed(d)).sourceTurns, [{ threadId: 'other-chat', turnId: 'other-turn' }]);
});

test('undo rechecks an outside edit made while its source dependencies are staged', async () => {
  const f = fixture(), d = f.draft(); acceptDraft(f.home, d.name);
  const s = (await f.view()).skills.find(x => x.state === 'active')!;
  value(await f.memory.handlers['skills.put']({ id: s.id, base: s.revision!, text: s.body! + '\nCheck dates.\n' }));
  const change = (await f.view()).skillChanges![0];
  // An outside edit to provenance requires undo to durably restore the snapshot's dependencies.
  assertHomeWriteAdmission(f.home, join(f.home, 'skills'));
  writeFileSync(join(f.home, 'skills', '.sources.json'), JSON.stringify({ [d.name]: [] }));
  const { result, text } = await editDuringStage(f.home, s, '.sources.json', () => f.memory.handlers['skills.undo']({ id: change.id }));
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'STALE_BASE');
  assert.equal(readFileSync(s.path, 'utf8'), text);
});

test('an interrupted save after publication reports unknown and leaves an undo for the observed edit', async () => {
  const f = fixture(), d = f.draft(); acceptDraft(f.home, d.name);
  const s = (await f.view()).skills.find(x => x.state === 'active')!;
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const rename = fs.renameSync;
  let failed = false;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (!failed && String(to) === s.path) { failed = true; throw new Error('Synthetic post-publication failure'); }
  };
  syncBuiltinESMExports();
  try {
    const r = await f.memory.handlers['skills.put']({ id: s.id, base: s.revision!, text: s.body! + '\nCheck dates.\n' });
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.outcome, 'UNKNOWN');
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(failed, true);
  const change = (await f.view()).skillChanges![0];
  value(await f.memory.handlers['skills.undo']({ id: change.id }));
  assert.equal(readFileSync(s.path, 'utf8'), s.body);
});

test('undoing removal uses the existing restore grace period before the curator can archive again', async () => {
  const f = fixture(), d = f.draft(); acceptDraft(f.home, d.name);
  const s = (await f.view()).skills.find(x => x.state === 'active')!;
  const { utimesSync } = await import('node:fs');
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  assertHomeWriteAdmission(f.home, dirname(s.path)); utimesSync(s.path, old, old);
  assertHomeWriteAdmission(f.home, join(f.home, 'skills'));
  writeFileSync(join(f.home, 'skills', '.usage.json'), JSON.stringify({ [s.name]: { offered: 0, used: 0, since: old.toISOString() } }));
  value(await f.memory.handlers['skills.remove']({ id: s.id, base: s.revision! }));
  value(await f.memory.handlers['skills.undo']({ id: (await f.view()).skillChanges![0].id }));
  assert.deepEqual(value(await f.memory.handlers['skills.curate']({})).archived, []);
  assert.equal((await f.view()).skills.find(x => x.id === s.id)?.state, 'active');
});

for (const file of ['.history.json', '.origins.json']) test(`a corrupt ${file} leaves Memory usable and cannot hold back withdrawal of a skill`, async () => {
  const f = fixture(), d = f.draft();
  assertHomeWriteAdmission(f.home, join(f.home, 'skills'));
  writeFileSync(join(f.home, 'skills', file), '{not json');
  const before = await f.view();
  assert.equal(before.skills.length, 1);
  assert.ok(before.skillNotice);
  f.withdrawn.add('source');
  assert.doesNotThrow(() => f.memory.purgeSource('source'));
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(d.path), false);
  assert.equal((await f.view()).skills.length, 0);
});

test('unrecognised present memory values cannot enable recall or child memory', async () => {
  const f = fixture();
  for (const memory of ['Off', 'disabled', true]) {
    const settingsValue = { ...settings, memory } as never;
    assert.equal((await f.memory.forTurn('p', 'report', settingsValue))!.recall().record.off, true);
    const child = narrowSettings(settingsValue, {}, 'worker');
    assert.ok('settings' in child && child.settings.memory === 'off');
  }
});

for (const file of ['.history.json', '.origins.json']) test(`withdrawal unlinks an unsafe ${file} without changing its external target`, async () => {
  const f = fixture(), d = f.draft();
  const { rmSync, symlinkSync, existsSync } = await import('node:fs');
  const path = join(f.home, 'skills', file), target = join(f.home, 'other-record.txt');
  assertHomeWriteAdmission(f.home); writeFileSync(target, 'Unrelated local text.');
  assertHomeWriteAdmission(f.home, join(f.home, 'skills')); rmSync(path, { force: true }); symlinkSync(target, path);
  assert.ok((await f.view()).skillNotice);
  f.withdrawn.add('source');
  assert.doesNotThrow(() => f.memory.purgeSource('source'));
  assert.equal(existsSync(d.path), false);
  assert.equal(readFileSync(target, 'utf8'), 'Unrelated local text.');
});

test('a blocked recovery-record cleanup reports pending after independently removing the withdrawn skill', async () => {
  const f = fixture(), d = f.draft();
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const path = join(f.home, 'skills', '.history.json');
  assertHomeWriteAdmission(f.home, join(f.home, 'skills')); writeFileSync(path, '{not json');
  const remove = fs.rmSync;
  fs.rmSync = (at, options) => { if (String(at) === path) throw new Error('Synthetic blocked cleanup'); remove(at, options); };
  syncBuiltinESMExports();
  f.withdrawn.add('source');
  try {
    assert.throws(() => f.memory.purgeSource('source'), { reason: 'NOT_AVAILABLE' });
    assert.equal(fs.existsSync(d.path), false);
    const view = await f.view();
    assert.equal(view.skills.length, 0); assert.ok(view.skillNotice);
  } finally { fs.rmSync = remove; syncBuiltinESMExports(); }
  assert.doesNotThrow(() => f.memory.purgeSource('source'));
  assert.equal(fs.existsSync(path), false);
});
