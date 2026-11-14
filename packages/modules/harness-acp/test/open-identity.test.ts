import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { assertDirectory, assertOpenedDirectory, assertOpenedFile, directoryIdentity } from '../src/directories.ts';
import { scratchFile } from '../src/files.ts';
import { toolBridge } from '../src/mcp.ts';

test('post-open comparisons refuse an outside file or working-directory handle even with an intact named parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-open-identity-')), work = join(root, 'work'), other = join(root, 'other');
  await mkdir(work); await mkdir(other); await writeFile(join(work, 'plain'), 'inside'); await writeFile(join(other, 'plain'), 'outside');
  const identity = directoryIdentity(work), outside = await open(join(other, 'plain'), 'r'), otherDir = await open(other, constants.O_RDONLY | constants.O_DIRECTORY);
  const inside = await open(join(work, 'plain'), 'r'), workDir = await open(work, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    assertOpenedFile(identity, join(work, 'plain'), await inside.stat()); assertOpenedDirectory(identity, await workDir.stat());
    const outsideInfo = await outside.stat(), outsideDirectory = await otherDir.stat();
    assert.throws(() => assertOpenedFile(identity, join(work, 'plain'), outsideInfo), /opened file/);
    assert.throws(() => assertOpenedDirectory(identity, outsideDirectory), /opened directory/);
  } finally { await Promise.all([outside.close(), otherDir.close(), inside.close(), workDir.close()]); await rm(root, { recursive: true, force: true }); }
});

for (const body of [undefined, 'overwrite']) test(`scratch ${body === undefined ? 'read' : 'write'} refuses a name replaced after open, before using the handle`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-open-file-race-')), path = join(root, 'plain');
  await writeFile(path, 'original');
  const identity = directoryIdentity(root), probe = await open(path, 'r'), inode = (await probe.stat()).ino;
  const prototype = Object.getPrototypeOf(probe), original = prototype.stat; let swapped = false;
  try {
    prototype.stat = async function (...args: unknown[]) {
      const info = await original.apply(this, args);
      if (!swapped && info.ino === inode) { swapped = true; await rename(path, path + '-old'); await writeFile(path, 'replacement'); }
      return info;
    };
    await assert.rejects(scratchFile(identity, path, body), /unavailable|linked/); assert.equal(swapped, true);
    assert.equal(await readFile(path, 'utf8'), 'replacement'); assert.equal(await readFile(path + '-old', 'utf8'), 'original');
  } finally { prototype.stat = original; await probe.close(); await rm(root, { recursive: true, force: true }); }
});

test('capability creation rechecks the opened file and parent before writing any token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-open-cap-race-')), state = join(root, 'agent'), moved = state + '-old';
  await mkdir(state, { mode: 0o700 });
  const identity = directoryIdentity(state), probe = await open(join(state, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe), original = prototype.stat; let swapped = false;
  try {
    prototype.stat = async function (...args: unknown[]) {
      const info = await original.apply(this, args);
      if (!swapped && info.isFile()) { swapped = true; await rename(state, moved); await mkdir(state, { mode: 0o700 }); }
      return info;
    };
    await assert.rejects(toolBridge(() => undefined, () => {}, () => {}, identity, () => assertDirectory(identity)), /folder was replaced/);
    assert.equal(swapped, true); assert.deepEqual(await readdir(state), []);
    const capability = (await readdir(moved)).find(name => name.startsWith('bridge-')); assert.ok(capability);
    assert.equal(await readFile(join(moved, capability), 'utf8'), '', 'no secret was written through the changed parent');
  } finally { prototype.stat = original; await probe.close(); await rm(root, { recursive: true, force: true }); }
});

for (const folder of ['work', 'state'] as const) test(`agent spawn checks the opened ${folder} directory handle against its recorded identity`, async () => {
  const fs = await import('node:fs'), { syncBuiltinESMExports } = await import('node:module');
  const { AgentProcess } = await import('../src/transport.ts');
  const root = await mkdtemp(join(tmpdir(), 'acp-spawn-handle-')), work = join(root, 'work'), state = join(root, 'agent'), other = join(root, 'other');
  for (const dir of [work, state, other]) await mkdir(dir);
  const workIdentity = directoryIdentity(work), stateIdentity = directoryIdentity(state), target = folder === 'work' ? work : state;
  const original = fs.default.openSync; let substituted = 0, agent: InstanceType<typeof AgentProcess> | undefined;
  try {
    fs.default.openSync = ((path: Parameters<typeof original>[0], ...args: unknown[]) => { if (path === target) { substituted++; return Reflect.apply(original, fs.default, [other, ...args]); } return Reflect.apply(original, fs.default, [path, ...args]); }) as typeof original;
    syncBuiltinESMExports();
    assert.throws(() => { agent = new AgentProcess({ acceptsProcessVisibility: true, command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], environment: 'person-rights' }, workIdentity, stateIdentity); }, /opened directory/);
    assert.equal(substituted, 1);
  } finally { fs.default.openSync = original; syncBuiltinESMExports(); await agent?.close(); await rm(root, { recursive: true, force: true }); }
});
