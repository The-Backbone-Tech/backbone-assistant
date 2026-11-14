import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MaterialStore } from '../src/stub/material.ts';

test('an internal reader sees a committed version without recovering a live Save', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'material-live-save-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const writer = new MaterialStore(home, { saveDelayMs: 100 }, () => {});
  const reader = new MaterialStore(home, {}, () => {});
  const entry = writer.create('project', 'draft.md', 'text/markdown', Buffer.from('v1'), 'working', 'agent');
  const saving = writer.save(entry.id, 'person v2', 1);
  assert.equal(existsSync(join(home, 'material', entry.id, 'intent.json')), true);
  assert.equal(reader.load(entry.id)?.current, 1);
  assert.equal(Buffer.from(reader.bytes(entry.id, 1)).toString(), 'v1');
  const result = await saving;
  assert.equal(result.ok, true);
  assert.equal(reader.load(entry.id)?.current, 2);
  assert.equal(Buffer.from(reader.bytes(entry.id, 2)).toString(), 'person v2');
});
