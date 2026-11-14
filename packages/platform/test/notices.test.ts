import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readNotice, listNotices } from '../src/notices.ts';

test('notices read only indexed build resources, verify bytes and refuse missing or escaping entries', t => {
  const root = mkdtempSync(join(tmpdir(), 'notice-reader-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const text = 'Copyright Fixture\nMIT licence text';
  const entry = { id: 'fixture@1', name: 'fixture', version: '1', license: 'MIT', format: 'text', file: '0.txt', sha256: createHash('sha256').update(text).digest('hex') };
  writeFileSync(join(root, '0.txt'), text);
  const index = () => writeFileSync(join(root, 'index.json'), JSON.stringify({ schema: 1, entries: [entry], artifacts: [] })); index();
  assert.equal(listNotices(root)[0].id, entry.id);
  assert.equal(readNotice(root, entry.id).text, text);
  assert.throws(() => readNotice(root, '../private'), /notice/i);
  writeFileSync(join(root, '0.txt'), 'changed'); assert.throws(() => readNotice(root, entry.id), /digest/i);
  entry.file = '../private'; index(); assert.throws(() => listNotices(root), /notice/i);
  rmSync(join(root, 'index.json')); assert.throws(() => listNotices(root), /notice/i);
});
