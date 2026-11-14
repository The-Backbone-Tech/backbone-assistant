// A denied socket-name query can make Node classify inherited Unix stdio sockets as unknown.
// Capture must still receive immutable bytes and fixed refusal diagnostics through its descriptors.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SNAPSHOT_PROGRAM } from '../src/snapshot.ts';

const blackhole = `const {Writable}=require('node:stream'); for(const name of ['stdout','stderr']) Object.defineProperty(process,name,{value:new Writable({write(_data,_encoding,done){done();}})});`;
for (const adverse of [false, true]) test(`snapshot descriptor output survives black-hole Node streams (adverse=${adverse})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-snapshot-io-'));
  try {
    await writeFile(join(root, 'note.md'), 'Immutable source');
    if (adverse) await symlink(join(root, 'note.md'), join(root, 'bad.md'));
    const result = spawnSync(process.execPath, ['--openssl-config=/dev/null', '-e', blackhole + SNAPSHOT_PROGRAM], { cwd: root, encoding: 'utf8' });
    assert.equal(result.signal, null);
    if (adverse) {
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Native staged snapshot refused.');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { files: [{ name: 'note.md', base64: Buffer.from('Immutable source').toString('base64') }], inspection: [] });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
