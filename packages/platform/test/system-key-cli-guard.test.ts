import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scratchGuard } from './system-key-cli-guard.ts';
import { securityWord, type ToolRequest } from '../src/system-keys/tools.ts';
const keychain = '/scratch/test.keychain-db';
test('scratch preload refuses a missing hook before any possible store spawn', () => {
  const guard = scratchGuard(keychain);
  assert.throws(() => guard.checkSpawn('/usr/bin/security', ['default-keychain', '-d', 'user']), /hook did not load/);
  assert.throws(() => guard.assertHook(), /hook did not load/);
});
test('scratch preload independently refuses all unscoped, locked and preference calls', () => {
  const guard = scratchGuard(keychain); guard.markHook();
  for (const args of [['default-keychain', '-d', 'user'], ['lock-keychain', keychain], ['show-keychain-info', keychain], ['find-generic-password', '-w'], ['find-generic-password', '-w', '/other/test.keychain-db'], ['-q', '-i']]) {
    assert.throws(() => guard.checkSpawn('/usr/bin/security', args));
  }
  assert.throws(() => guard.checkSpawn('/usr/bin/secret-tool', ['lookup']));
  guard.checkSpawn('/usr/bin/security', ['find-generic-password', '-w', keychain]);
  guard.assertHook();
});
test('scratch preload validates interactive scope before launching and grants only that invocation', () => {
  const guard = scratchGuard(keychain); guard.markHook(); let launches = 0;
  const request: ToolRequest = { executable: '/usr/bin/security', args: ['-q', '-i'], input: Buffer.from('"add-generic-password" "-w" "synthetic" ' + securityWord(keychain) + '\n'), env: {} };
  const launch = (r: ToolRequest) => { guard.checkSpawn(r.executable, r.args); launches++; };
  guard.run(request, launch); assert.equal(launches, 1);
  assert.throws(() => guard.checkSpawn(request.executable, request.args));
  for (const input of ['"add-generic-password"\n', '"add-generic-password" "/other/scratch"\n', request.input!.toString() + '"find-generic-password"\n', '"lock-keychain" ' + securityWord(keychain) + '\n']) {
    assert.throws(() => guard.run({ ...request, input: Buffer.from(input) }, launch));
  }
  assert.equal(launches, 1, 'all refused requests stop before the launch seam');
});
