import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectRecoveredWrites, type StoredWrite } from '../src/composition/recovered-writes.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { sha256 } from '../src/stub/fsx.ts';

function write(status: string): StoredWrite {
  return { id: 'original-effect', status, args: { document_id: 'draft', title: 'draft.md', content_sha256: sha256('agent v1'), base_version: null } };
}
function store() {
  const home = mkdtempSync(join(tmpdir(), 'recovered-writes-'));
  return { material: new MaterialStore(home, {}, () => {}), clean: () => rmSync(home, { recursive: true, force: true }) };
}

test('recovery exposes the original UNKNOWN identity independently of new model calls', () => {
  const s = store();
  try {
    const original = write('unknown');
    const result = projectRecoveredWrites([original], s.material, 'project');
    assert.equal(result.stop, true);
    assert.deepEqual(result.effects.map((x) => [x.key, x.target, x.outcome]), [['original-effect', 'draft.md', 'UNKNOWN']]);
    assert.match(result.detail, /UNKNOWN/);
    assert.deepEqual(result.files, []);
    assert.deepEqual(original, write('unknown'), 'original arguments and status are never rewritten');
  } finally { s.clean(); }
});

test('a later person save cannot become the recovered agent result', async () => {
  const s = store();
  try {
    const e = s.material.create('project', 'draft.md', 'text/markdown', Buffer.from('agent v1'), 'working', 'agent', 'draft');
    assert.equal((await s.material.save(e.id, 'person v2', 1)).ok, true);
    const result = projectRecoveredWrites([write('succeeded')], s.material, 'project');
    assert.equal(result.stop, true);
    assert.deepEqual(result.files, [{ materialId: 'draft', name: 'draft.md', version: 1 }]);
    assert.equal(result.effects[0].outcome, 'DONE');
    assert.equal(s.material.load('draft')?.current, 2);
  } finally { s.clean(); }
});

test('a matching older hash does not prove the expected later write landed', () => {
  const s = store();
  try {
    s.material.create('project', 'draft.md', 'text/markdown', Buffer.from('agent v1'), 'working', 'agent', 'draft');
    const prior = write('succeeded');
    prior.args.base_version = 3;
    const result = projectRecoveredWrites([prior], s.material, 'project');
    assert.equal(result.stop, true);
    assert.equal(result.files.length, 0);
    assert.match(result.detail, /artifact|version/i);
  } finally { s.clean(); }
});

test('a succeeded receipt with missing or foreign material cannot verify a result', () => {
  const s = store();
  try {
    s.material.create('other-project', 'draft.md', 'text/markdown', Buffer.from('agent v1'), 'working', 'agent', 'draft');
    const result = projectRecoveredWrites([write('succeeded')], s.material, 'project');
    assert.equal(result.stop, true);
    assert.equal(result.files.length, 0);
    assert.match(result.detail, /artifact|version/i);
  } finally { s.clean(); }
});

test('a known pending write remains visible while exact gateway recovery is possible', () => {
  const s = store();
  try {
    const result = projectRecoveredWrites([write('claimed')], s.material, 'project');
    assert.equal(result.stop, false);
    assert.equal(result.effects[0].key, 'original-effect');
    assert.equal(result.effects[0].outcome, 'UNKNOWN', 'temporary projection makes no success claim');
    assert.match(result.effects[0].detail ?? '', /pending.*claimed/i);
  } finally { s.clean(); }
});

test('a prior failed write is terminal and does not create a fresh attempt', () => {
  const s = store();
  try {
    const result = projectRecoveredWrites([write('failed')], s.material, 'project');
    assert.equal(result.stop, true);
    assert.equal(result.effects[0].outcome, 'REFUSED');
    assert.deepEqual(result.files, []);
  } finally { s.clean(); }
});
