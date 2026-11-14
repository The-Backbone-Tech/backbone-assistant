// A closed host changes nothing: a window still open after it closed (a test page, a renderer during
// quit) gets a refusal, and the home it is removing is never written again (the task-selection
// journey's leftover folder held a draft saved after its host closed).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostClosed, removeDataHome } from '../src/composition/host.ts';
import { open, value } from './helpers.ts';
import { CoreLink } from '../src/composition/core.ts';
import { TEST_HANG_MS, hangDetector } from '../../../scripts/lib/test-hang.ts';

test('after close, every call is refused (a write or a read), and a removed home stays removed', async () => {
  const { home, host } = open();
  value(await host.call('projects.create', { name: 'Before', kind: 'folder' }));
  host.close();
  await hostClosed(home);
  await removeDataHome(home);
  await assert.rejects(host.call('drafts.put', { key: 'composer:late', text: 'typed while closing', clientKey: 'late' }), /closing/, 'a write is refused');
  assert.equal(existsSync(join(home, 'drafts')), false, 'nothing written');
  await assert.rejects(host.call('files.list', { projectId: 'any' }), /closing/, 'a read is refused too, not answered with an empty list');
  assert.equal((await host.call('host.status', {} as never) as { ok?: boolean }) !== undefined, true, 'host.status still answers');
  assert.equal(existsSync(home), false, 'the removed home is not recreated, by a write or a read');
});

test('after close, the main process\'s own entries refuse too: a signing dialog answered late signs nothing, a held call is not released', async () => {
  const { home, host } = open();
  value(await host.call('projects.create', { name: 'Before', kind: 'folder' }));
  host.close();
  // A presence dialog the person approved before quitting, answered after close: no real signature is made here.
  const signed = await host.signCapability({} as never);
  assert.equal(signed.ok, false);
  assert.match((signed as { detail: string }).detail, /closing/, 'refused for closing, not for the fake request');
  for (const late of [host.releaseConnectorCall('effect', 'hash'), host.openConnectorDoor('server', 'seal'), host.markConnectorToolRead('server', 'tool'), host.connectTool({} as never)]) {
    const r = await late;
    assert.equal(r.ok, false);
    assert.match((r as { detail: string }).detail, /closing/);
  }
  await assert.rejects(host.importExport(home), /closing/);
  assert.equal(await host.resumeInterrupted(), 0);
  await hostClosed(home);
});

test('a late entry after close is refused at once, even while the core is still opening', { timeout: TEST_HANG_MS * 4 }, async t => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const opening = new Promise<void>(resolve => { entered = resolve; });
  const original = CoreLink.open;
  t.mock.method(CoreLink, 'open', async (...args: Parameters<typeof original>) => {
    // Preserve the real opener's close-cache snapshot; hold publication of its result.
    const link = await original.apply(CoreLink, args);
    entered(); await held; return link;
  });
  const { home, host } = open();
  try {
    await hangDetector(opening, 'Core open reaches held publication');
    host.close();
    await hangDetector((async () => {
      const signed = await host.signCapability({} as never);
      assert.equal(signed.ok, false);
      assert.match((signed as { detail: string }).detail, /closing/);
      const released = await host.releaseConnectorCall('effect', 'hash');
      assert.match((released as { detail: string }).detail, /closing/);
      assert.equal(await host.resumeInterrupted(), 0);
    })(), 'closed entries refuse while Core open remains held');
  } finally { release(); host.close(); await hangDetector(hostClosed(home), 'held Core closes'); }
});
