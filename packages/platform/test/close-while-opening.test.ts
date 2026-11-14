import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// A host closed at once, before its core has opened, settles: opening stops and the home is released.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostClosed } from '../src/composition/host.ts';
import { freshHome, open, value } from './helpers.ts';


test('createHost followed at once by close settles both, and the home opens again afterwards', async () => {
  const home = freshHome();
  const first = open(home);
  first.host.close();
  await hangDetector(hostClosed(home), 'closing during opening');
  const again = open(home);
  const projects = await hangDetector(again.host.call('projects.list', {}), 'opening again');
  assert.ok(Array.isArray(projects));
  value(await again.host.call('projects.create', { name: 'After', kind: 'folder' }));
});
