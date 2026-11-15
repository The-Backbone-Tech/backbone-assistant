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

test('a shared parent removed during allocation is retried in the form macOS sometimes reports it', async () => {
  // Another process closing its last session removes the empty shared parent. mkdtemp then fails with
  // ENOENT, or on macOS now and then with EINVAL (observed 415 times in 83,000 contended calls).
  // The session works under the resolved path, so the stand-in matches on that.
  const temporaryRoot = await filesystem.realpath(await mkdtemp(join(tmpdir(), 'acp-default-storage-')));
  const real = filesystem.mkdtemp; let session: Session | undefined; let vanished = 1;
  try {
    filesystem.mkdtemp = (async (prefix: string, ...rest: unknown[]) => {
      if (prefix.startsWith(temporaryRoot) && vanished-- > 0) throw Object.assign(new Error('EINVAL: invalid argument, mkdtemp'), { code: 'EINVAL', syscall: 'mkdtemp' });
      return (real as (...args: unknown[]) => Promise<string>)(prefix, ...rest);
    }) as typeof filesystem.mkdtemp;
    syncBuiltinESMExports();
    session = await Session.create({ command: process.execPath, args: [], temporaryRoot }, 'thread');
    assert.ok(vanished <= 0, 'the stand-in was reached');
    assert.ok(session.root.startsWith(temporaryRoot));
    // An invalid argument from anything else is not this race and is not retried.
    let attempts = 0;
    filesystem.mkdtemp = (async () => { attempts++; throw Object.assign(new Error('EINVAL'), { code: 'EINVAL', syscall: 'open' }); }) as typeof filesystem.mkdtemp;
    syncBuiltinESMExports();
    await assert.rejects(Session.create({ command: process.execPath, args: [], temporaryRoot }, 'other'), { code: 'EINVAL' });
    assert.equal(attempts, 1, 'tried once, not eight times');
  } finally {
    filesystem.mkdtemp = real; syncBuiltinESMExports();
    await session?.close(true).catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
