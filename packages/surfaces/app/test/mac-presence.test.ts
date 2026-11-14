import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessState, loginItemState, trayMenu } from '../electron/mac-presence-model.ts';

test('folder access reports only a successful read as allowed', () => {
  assert.equal(accessState(null), 'allowed');
  assert.equal(accessState({ code: 'EPERM' }), 'denied');
  assert.equal(accessState({ code: 'ENOENT' }), 'unavailable');
});
test('login item is offered only by a packaged Mac app', () => {
  assert.equal(loginItemState('darwin', true, true), true);
  assert.equal(loginItemState('darwin', false, true), null);
  assert.equal(loginItemState('linux', true, true), null);
});
test('tray offers open, new chat and quit', () => {
  assert.deepEqual(trayMenu('Backbone').map(item => item.label), ['Open Backbone', 'New chat', 'Quit']);
});

test('folder names accepted for a single request are limited to protected folders', async () => {
  const { folders, isFolder } = await import('../electron/mac-presence-model.ts');
  assert.deepEqual(folders, ['Desktop', 'Documents', 'Downloads']);
  for (const folder of folders) assert.equal(isFolder(folder), true);
  assert.equal(isFolder('Pictures'), false);
  assert.equal(isFolder('../Downloads'), false);
  assert.equal(accessState({ code: 'EACCES' }), 'denied');
});

test('active sharing is visible in the menu with a direct off control',()=>{
  const menu=trayMenu('Backbone','https://127.0.0.1:8443');
  assert.ok(menu.some(item=>item.label==='Sharing with other computers is on: https://127.0.0.1:8443'));
  assert.ok(menu.some(item=>item.label==='Turn sharing off in Settings…'&&item.action==='sharing-off'));
});
