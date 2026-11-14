import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open } from './helpers.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { sharedCertificate } from '../src/composition/shared-certificate.ts';
import { hangDetector } from '../../../scripts/lib/test-hang.ts';

test('a ready Host can create and reuse its certificate without waiting on itself', async () => {
  const keys = plaintextKeys();
  const { home, host } = open(undefined, { keys });
  await host.call('projects.list', {});
  const [first, concurrent] = await hangDetector(Promise.all([
    sharedCertificate(home, keys),
    sharedCertificate(home, keys),
    host.call('projects.list', {}),
  ]), 'the open Host and concurrent certificate preparation finish');
  assert.equal(first.fingerprint, concurrent.fingerprint);
  assert.equal((await sharedCertificate(home, keys)).fingerprint, first.fingerprint);
  assert.deepEqual(await host.call('projects.list', {}), []);
});
