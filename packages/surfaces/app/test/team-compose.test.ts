import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Host } from '@backbone-next/platform/composition';
import { RendererIdentitySessions } from '../electron/identity-session.ts';

for (const change of ['quit', 'account'] as const) test(`pending device recovery refuses after ${change}`, async () => {
  let settle!: (value: { available: boolean }) => void, repairs = 0;
  const pending = new Promise<{ available: boolean }>(resolve => { settle = resolve; });
  const host = { call: async () => { throw Object.assign(new Error('Access ended'), { name: 'IdentityRefused' }); },
    deviceRecoveryStatus: () => pending, restoreDeviceAccess: async () => { repairs++; }, on: () => () => {}, onAuthenticated: () => () => {},
    acceptInvitation: async () => ({ ok: true, value: { session: 'new-session', person: { id: 'other', name: 'Other', role: 'owner', status: 'active' } } }),
  } as unknown as Host;
  const sessions = new RendererIdentitySessions(host);
  sessions.bind({ id: 1, prepare: async () => true, reload: async () => {}, failed() {}, event() {} }, true);
  await assert.rejects(sessions.call(1, 'identity.get', {}));
  const repair = sessions.restoreDeviceAccess(1);
  const refused = assert.rejects(repair);
  if (change === 'quit') (sessions as unknown as { close(): void }).close();
  else await sessions.join(1, 'invitation', 'Other');
  settle({ available: true });
  await refused;
  assert.equal(repairs, 0);
});

test('Full access card reflects the device and live project audience', async () => {
  const { createServer } = await import('vite');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { FullAccessNotice } = await server.ssrLoadModule('/src/components/FullAccessCard.tsx');
    const render = (options: object) => renderToStaticMarkup(createElement(FullAccessNotice, {
      engine: 'codex', deviceOwner: true, shared: false, viewerOnly: false, decide() {}, ...options,
    }));
    assert.match(render({}), /connectors of your own Codex app/);
    assert.match(render({ shared: true }), /Full access/);
    assert.doesNotMatch(render({ shared: true }), /connectors of your own Codex app|mail, calendar/);
    assert.equal(render({ deviceOwner: false }), '');
    assert.equal(render({ viewerOnly: true }), '');
    assert.equal(render({ shared: undefined }), '');
    assert.doesNotMatch(render({ engine: 'other' }), /Codex/);
  } finally { await server.close(); }
});

test('quitting withdraws an already admitted device recovery before its commit', async () => {
  let entered!: () => void, release!: () => void, restored = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const host = { call: async () => { throw Object.assign(new Error('Access ended'), { name: 'IdentityRefused' }); },
    deviceRecoveryStatus: async () => ({ available: true }), on: () => () => {},
    restoreDeviceAccess: async (signal?: AbortSignal) => { entered(); await held; signal?.throwIfAborted(); restored = true; },
  } as unknown as Host;
  const sessions = new RendererIdentitySessions(host);
  sessions.bind({ id: 1, prepare: async () => true, reload: async () => {}, failed() {}, event() {} }, true);
  await assert.rejects(sessions.call(1, 'identity.get', {}));
  const repair = sessions.restoreDeviceAccess(1), refused = assert.rejects(repair);
  await started; sessions.close(); release(); await refused;
  assert.equal(restored, false);
});

test('a signed-in window never borrows device inspection authority, even for the same person', async () => {
  const sessions = new RendererIdentitySessions({ on: () => () => {}, onAuthenticated: () => () => {},
    acceptInvitation: async () => ({ ok: true, value: { session: 'device-person-session', person: { id: 'device', name: 'Device', role: 'owner', status: 'active' } } }),
  } as unknown as Host);
  sessions.bind({ id: 1, prepare: async () => true, reload: async () => {}, failed() {}, event() {} }, true);
  const pending = sessions.deviceSignal(1);
  await sessions.join(1, 'invitation', 'Device');
  assert.equal(pending.aborted, true);
  assert.equal(sessions.deviceOwner(1), false);
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('unknown-check'"), main.indexOf("ipcMain.handle('unknown-check'") + 400);
  assert.match(handler, /refuseOthers\(e\)/);
  const quit = main.slice(main.indexOf("app.on('before-quit'"));
  assert.ok(quit.indexOf('identitySessions.close()') < quit.indexOf('if (pendingUpgrade)'));
  assert.match(quit, /pendingUpgrade\.abort\(\)/);
});
