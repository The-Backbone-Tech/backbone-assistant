import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHost, hostClosed, removeDataHome } from '../src/composition/host.ts';
import { Vault } from '../src/keys/vault.ts';
import { chooseKeys, SYSTEM_WRAP } from '../src/system-keys/index.ts';
import { runTool, securityWord, toolEnvironment, toolStore, type ToolRunner } from '../src/system-keys/tools.ts';

import { cleanupTemporaryKeychain } from './system-key-cleanup.ts';

const enabled = process.platform === 'darwin' && process.env.BACKBONE_TEST_SYSTEM_KEYCHAIN === '1';
test('real-store integration is explicitly opt-in and macOS only', (t) => {
  if (!enabled) t.diagnostic('Real key store not accessed. Set BACKBONE_TEST_SYSTEM_KEYCHAIN=1 on macOS for the isolated test.');
  assert.equal(enabled, process.platform === 'darwin' && process.env.BACKBONE_TEST_SYSTEM_KEYCHAIN === '1');
});

if (enabled) test('macOS temporary keychain: create, reopen, and remove an isolated system home without login access', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const denial = process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE;
  delete process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE;
  t.after(() => { if (denial === undefined) delete process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE; else process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE = denial; });
  const root = mkdtempSync(join(tmpdir(), 'backbone-isolated-keychain-'));
  const keychain = join(root, 'isolated.keychain-db'), home = join(root, 'home');
  const env = toolEnvironment('darwin', {});
  const password = randomBytes(32).toString('base64');
  const interactive = async (words: string[]) => runTool({ executable: '/usr/bin/security', args: ['-q', '-i'], input: Buffer.from(words.map(securityWord).join(' ') + '\n'), env });
  let created = false;
  try {
    // -p over the interactive pipe, never -P (GUI prompt), argv, env or a password file.
    const made = await interactive(['create-keychain', '-p', password, keychain]);
    assert.equal(made.code, 0, 'could not create the temporary test keychain'); created = true;
    const unlocked = await interactive(['unlock-keychain', '-p', password, keychain]);
    assert.equal(unlocked.code, 0, 'could not unlock the temporary test keychain');
    const scoped: ToolRunner = (request) => {
      assert.equal(request.executable, '/usr/bin/security');
      assert.ok(!request.args.includes('default-keychain'), 'the test must never use the default keychain');
      if (request.args[0] === '-q') {
        assert.ok(request.input?.toString().endsWith(`${securityWord(keychain)}\n`), 'write must name the temporary keychain');
      } else assert.equal(request.args.at(-1), keychain, 'read must name the temporary keychain');
      return runTool(request);
    };
    const store = toolStore({ platform: 'darwin', env: {}, keychain, run: scoped });
    const keys = await chooseKeys(home, {}, store);
    const host = createHost({ home, keys, harness: 'stub' });
    try { assert.equal((await host.call('projects.create', { name: 'My project', kind: 'folder' })).ok, true); }
    finally { host.close(); await hostClosed(home); }
    const file = JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8'));
    assert.equal(file.holder, 'keychain'); assert.equal(file.wrap, SYSTEM_WRAP); assert.equal(file.format, 1);
    assert.notEqual(Buffer.from(file.key, 'base64').length, 32);
    Vault.forget(home);
    const again = createHost({ home, keys: await chooseKeys(home, {}, store), harness: 'stub', readOnly: true });
    try { assert.deepEqual((await again.call('projects.list', {})).map((p) => p.name), ['My project']); }
    finally { again.close(); await hostClosed(home); }
    assert.equal(existsSync(join(home, 'pg', 'secrets.json')), false);
  } finally {
    await cleanupTemporaryKeychain(
      () => removeDataHome(home),
      async () => {
        // This finally runs even if removing the home throws. Always name the scratch path.
        if (created || existsSync(keychain)) {
          const removed = await runTool({ executable: '/usr/bin/security', args: ['delete-keychain', keychain], env });
          assert.equal(removed.code, 0, 'could not remove the temporary test keychain');
        }
      },
      () => rmSync(root, { recursive: true, force: true }),
    );
  }
});
