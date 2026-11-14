import assert from 'node:assert/strict';
import filesystem, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Session } from '../src/session.ts';

test('concurrent default session closes leave nothing after transient parent removal contention', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'acp-default-storage-'));
  const sessions: Session[] = [];
  const rmdir = filesystem.rmdir;
  try {
    sessions.push(...await Promise.all(['first', 'second'].map(threadId => Session.create({
      command: process.execPath, args: [], temporaryRoot,
    }, threadId))));
    // Reproduce both closes seeing another retirement entry before its unlink completes.
    let contended = 2;
    filesystem.rmdir = async path => {
      if (path === sessions[0].storage && contended-- > 0) {
        throw Object.assign(new Error('Another retirement is still finishing.'), { code: 'ENOTEMPTY' });
      }
      return rmdir(path);
    };
    syncBuiltinESMExports();
    await Promise.all(sessions.map(session => session.close(true)));
    assert.deepEqual(await readdir(temporaryRoot), [], 'the last close removes the empty shared parent');
  } finally {
    filesystem.rmdir = rmdir; syncBuiltinESMExports();
    await Promise.allSettled(sessions.map(session => session.close(true)));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('closing one default session preserves another live session and its state', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'acp-default-storage-live-'));
  const sessions: Session[] = [];
  try {
    for (const threadId of ['closing', 'live']) sessions.push(await Session.create({
      command: process.execPath, args: [], temporaryRoot,
    }, threadId));
    const nativeState = join(sessions[1].state, 'keep');
    await writeFile(nativeState, 'native state');
    await sessions[0].close(true);
    assert.equal(await readFile(nativeState, 'utf8'), 'native state');
    await sessions[1].close(true);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await Promise.allSettled(sessions.map(session => session.close(true)));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
