import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MaterialEntry, Turn } from '@backbone-next/platform';
import { workEvidence } from '../src/lib/work-evidence.ts';

const file = { materialId: 'source', name: 'note.md', version: 1 };
const turn = { user: { attachments: [file] }, reads: [{ id: 'source', name: 'note.md', version: 1, withdrawals: 0 }], answer: { files: [file] }, unknownSources: false } as Turn;
const entry = { id: 'source', current: 1, versions: [{ n: 1 }] } as MaterialEntry;

test('a later human version invalidates the current-version label without rewriting the recorded source or output', () => {
  const before = workEvidence(turn, [entry]);
  assert.equal(before.sources[0].state, 'current');
  const after = workEvidence(turn, [{ ...entry, current: 2, versions: [{ n: 1 }, { n: 2, by: 'person' }] } as MaterialEntry]);
  for (const row of [...after.sources, ...after.outputs]) {
    assert.equal(row.state, 'changed'); assert.equal(row.file.version, 1);
    assert.equal(row.canOpen, true); assert.match(row.note, /current is v2/);
  }
  assert.equal(turn.reads![0].version, 1);
});

test('withdrawal and restoration never turn an earlier read into a current source again', () => {
  const withdrawals = [{ at: '2026-11-02', version: 1 }];
  const withdrawn = workEvidence(turn, [{ ...entry, withdrawals }]);
  assert.equal(withdrawn.sources[0].state, 'withdrawn'); assert.equal(withdrawn.sources[0].canOpen, false);
  const restored = workEvidence(turn, [{ ...entry, withdrawals: [{ ...withdrawals[0], restoredAt: '2026-11-03' }] }]);
  assert.equal(restored.sources[0].state, 'access-changed'); assert.equal(restored.sources[0].canOpen, false);
});

test('missing, held, unavailable versions and failed/unperformed current-state reads cannot appear current', () => {
  assert.equal(workEvidence(turn, undefined).sources[0].state, 'unknown');
  assert.equal(workEvidence(turn, []).sources[0].state, 'missing');
  assert.equal(workEvidence(turn, [{ ...entry, versions: [] }]).sources[0].canOpen, false);
  assert.equal(workEvidence(turn, [{ ...entry, held: { id: 'x', name: 'withdrawn.md' } }]).sources[0].state, 'held');
});

test('attachments are not claimed to be reads when the read set is absent, and partial history stays explicit', () => {
  const old = workEvidence({ ...turn, reads: undefined }, [entry]);
  assert.equal(old.incomplete, true); assert.equal(old.sources[0].role, 'attached');
  assert.equal(workEvidence({ ...turn, unknownSources: true }, [entry]).incomplete, true);
  assert.equal(workEvidence({ ...turn, reads: [] }, [entry]).sources.length, 0);
});

test('an empty read set cannot look complete when recorded activity contains reads', () => {
  const legacy = { ...turn, reads: [], work: { ...turn.work, steps: [{ kind: 'read' as const, label: 'Read note.md v1' }] } };
  const view = workEvidence(legacy, [entry]);
  assert.equal(view.incomplete, true);
  assert.equal(view.sources[0].role, 'attached', 'keep known attachments without inventing a read binding from prose');
});


test('inherited context stays visible without concealing unbound new read activity', () => {
  const legacy = { ...turn, reads: turn.reads!.map((r) => ({ ...r, inherited: true })), work: { ...turn.work, steps: [{ kind: 'read' as const, label: 'Read another document' }] } };
  const view = workEvidence(legacy, [entry]);
  assert.equal(view.incomplete, true);
  assert.equal(view.sources[0].file.materialId, 'source', 'retain the actual known context binding');
});

test('staged copies are separate from used sources and an observed read takes precedence', () => {
  const staged = { ...turn.reads![0], available: true as const };
  const other = { ...staged, id: 'other', name: 'away-check.md' };
  const unused = workEvidence({ ...turn, reads: [staged, other] }, [entry]);
  assert.deepEqual(unused.sources, []);
  assert.deepEqual(unused.available.map(r => r.file.name), ['note.md', 'away-check.md']);
  assert.equal(unused.incomplete, false);
  const opened = workEvidence({ ...turn, reads: [staged, other, turn.reads![0]] }, [entry]);
  assert.deepEqual(opened.sources.map(r => r.file.name), ['note.md']);
  assert.deepEqual(opened.available.map(r => r.file.name), ['away-check.md']);
  const restored = workEvidence({ ...turn, reads: [staged] }, [{ ...entry, withdrawals: [{ at: 'then', version: 1, restoredAt: 'now' }] }]);
  assert.equal(restored.available[0].state, 'access-changed');
  assert.equal(restored.available[0].canOpen, false);
});
