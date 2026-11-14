import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { retireDirectory, sweepRetired } from '../src/storage.ts';

// A sweep from another test file, or another process of the same user (the app and the CLI),
// can run at any moment while a retire is recording its owner. Stand at the worst moment:
// the owner-record file exists but its content is not written yet.
test('a sweep between creating and writing the owner record neither removes it nor breaks the retire', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'acp-owner-race-'));
  const fs = await import('node:fs'), fsp = fs.promises, { syncBuiltinESMExports } = await import('node:module');
  const original = fsp.writeFile; let swept = 0;
  fsp.writeFile = (async (path: Parameters<typeof original>[0], data: Parameters<typeof original>[1], options?: Parameters<typeof original>[2]) => {
    if (typeof path !== 'string' || !path.startsWith(join(parent, '.retired-'))) return original(path, data, options);
    const handle = await fsp.open(path, 'wx', 0o600);
    try { await sweepRetired(parent); swept += 1; await handle.writeFile(data); } finally { await handle.close(); }
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const live = join(parent, 'live'); await mkdir(live, { mode: 0o700 });
    let ownerKept = false;
    await retireDirectory(live, (async () => { ownerKept = (await readdir(parent)).some(name => name.endsWith('.owner.json')); }) as never);
    assert.ok(ownerKept, 'the owner record survived the sweep and still protects the retired copy');
    assert.equal(swept, 1, 'the sweep ran at the moment between creation and write');
    await assert.rejects(access(live));
    assert.deepEqual((await readdir(parent)).filter(name => name.startsWith('.retired-')), []);
  } finally { fsp.writeFile = original; syncBuiltinESMExports(); await rm(parent, { recursive: true, force: true }); }
});
