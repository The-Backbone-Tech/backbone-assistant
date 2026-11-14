import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupTemporaryKeychain } from './system-key-cleanup.ts';
for (const fault of ['home', 'keychain']) test(`temporary keychain finally cleanup survives ${fault} failure`, async () => {
  const calls: string[] = [];
  await assert.rejects(cleanupTemporaryKeychain(
    async () => { calls.push('home'); if (fault === 'home') throw new Error('home failed'); },
    async () => { calls.push('keychain'); if (fault === 'keychain') throw new Error('keychain failed'); },
    () => { calls.push('folder'); },
  ), new RegExp(`${fault} failed`));
  assert.deepEqual(calls, ['home', 'keychain', 'folder']);
});
