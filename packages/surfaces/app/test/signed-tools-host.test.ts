import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { endSignature, signedTools } from '../src/lib/signed-tools.ts';
import { seedSignedHome } from './fixtures/signed-home.ts';

test('a real read-only Host refuses an end and its signed row remains; re-signing creates a new row', async () => {
  const home = freshDataHome('signed-tools-host');
  try {
    const seeded = await seedSignedHome(home);
    const original = signedTools(seeded)[0];
    const host = createHost({ home, harness: 'stub', readOnly: true });
    try {
      const result = await endSignature((method, args) => host.call(method, args), original);
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.detail, /read-only/);
      assert.deepEqual(signedTools(await host.call('connectors.list', {})).map(r => r.key), [original.key]);
    } finally { host.close(); await hostClosed(home); }
    const writer = createHost({ home, harness: 'stub' });
    try {
      assert.equal((await endSignature((method, args) => writer.call(method, args), original)).ok, true);
      assert.equal(signedTools(await writer.call('connectors.list', {})).length, 0);
      const shown = writer.connectorToolView('home:notes', 'draft_note')!;
      assert.equal((await writer.signConnectorTool('home:notes', 'draft_note', shown.seal, shown.stamp, false)).ok, true);
      const rows = signedTools(await writer.call('connectors.list', {}));
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].key, original.key);
    } finally { writer.close(); await hostClosed(home); }
  } finally { await removeDataHome(home); }
});
