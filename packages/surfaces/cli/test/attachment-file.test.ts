import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, openSync, closeSync, ftruncateSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { attachFile } from '../src/first-job.ts';
import type { Api } from '../src/commands.ts';

test('attach accepts only a regular file of at most 25 MiB, including symlink targets', async t => {
  const at = mkdtempSync(join(tmpdir(), 'attach-source-')); t.after(() => rmSync(at, { recursive: true, force: true }));
  const file = join(at, 'note.md'); writeFileSync(file, 'a note'); symlinkSync(file, join(at, 'note-link.md'));
  mkdirSync(join(at, 'folder')); symlinkSync(join(at, 'folder'), join(at, 'folder-link'));
  const large = join(at, 'large'); const fd = openSync(large, 'w'); ftruncateSync(fd, 25 * 1024 * 1024 + 1); closeSync(fd);
  const called: string[] = []; const api = { async call(method: string) { called.push(method); return { ok: true, value: { id: 'source' } }; } } as unknown as Api;
  for (const path of [join(at, 'folder'), join(at, 'folder-link'), large, ...(process.platform === 'win32' ? [] : ['/dev/null'])]) {
    const r = await attachFile(api, 'p', path); assert.equal(r.ok, false, path); if (!r.ok) { assert.equal(r.reason, 'INVALID'); assert.match(r.detail, /regular file|25 MiB/); }
  }
  assert.equal(called.length, 0);
  assert.ok((await attachFile(api, 'p', file)).ok); assert.ok((await attachFile(api, 'p', join(at, 'note-link.md'))).ok); assert.equal(called.length, 2);
});
