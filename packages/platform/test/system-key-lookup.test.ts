import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTool, toolStore } from '../src/system-keys/tools.ts';

for (const mode of ['missing', 'locked', 'dismissed', 'error']) test(`fake secret-tool executable: ${mode} lookup`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-secret-service-'));
  const script = join(root, 'service-fixture.mjs'), log = join(root, 'operations');
  writeFileSync(log, '');
  writeFileSync(script, `
    import {appendFileSync} from 'node:fs';
    const command=process.argv[2],mode=process.env.FAKE_MODE;
    appendFileSync(process.env.FAKE_LOG,command+'\\n');
    if(command==='lookup') { if(mode==='error') process.stderr.write('private diagnostic'); process.exit(1); }
    if(command==='search') {
      if(mode==='locked'||mode==='dismissed') {
        process.stdout.write('[/locked-item]\\nlabel = unavailable-canary\\n');
        if(mode==='locked') process.stderr.write('Item is locked');
      }
      process.exit(0);
    }
    if(command==='store') { for await(const chunk of process.stdin) {} process.exit(0); }
    process.exit(9);
  `);
  try {
    const store = toolStore({ platform: 'linux', env: {}, run: (r) => runTool({ ...r, executable: process.execPath, args: [script, ...r.args], env: { ...r.env, FAKE_MODE: mode, FAKE_LOG: log } }) });
    if (mode === 'missing') {
      assert.equal(await store.get(randomUUID()), null);
      await store.create(randomUUID(), randomBytes(32));
      assert.equal(readFileSync(log, 'utf8'), 'lookup\nsearch\nlookup\nsearch\nstore\n');
    } else {
      await assert.rejects(store.get(randomUUID()), (e: Error) => { assert.match(e.message, /No usable system key store/); assert.ok(!e.message.includes('unavailable-canary')); return true; });
      await assert.rejects(store.create(randomUUID(), randomBytes(32)), /No usable system key store/);
      assert.ok(!readFileSync(log, 'utf8').includes('store'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('macOS exit 44 with an unreachable scratch keychain is unavailable, not a missing item', async () => {
  const calls: string[][] = [];
  const store = toolStore({ platform: 'darwin', env: {}, keychain: '/tmp/unreachable-scratch.keychain-db', run: async (r) => {
    calls.push(r.args);
    return { code: r.args[0] === 'find-generic-password' ? 44 : 1, stdout: Buffer.alloc(0), errorOutput: true };
  } });
  await assert.rejects(store.get(randomUUID()), /No usable system key store/);
  assert.deepEqual(calls, [], 'missing keychain is refused by filesystem metadata before a lookup');
});
