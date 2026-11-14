// Electron's security checklist, item 17: validate the sender of every IPC message. Only the app's
// own top-level page may call main; a subframe, another page or a navigated-away window may not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trustedSender } from '../electron/sender.ts';

const page = 'file:///Applications/Assistant.app/Contents/Resources/app.asar/dist/renderer/index.html';

test('only the app’s own top-level page is a trusted sender', () => {
  assert.equal(trustedSender({ url: page, parent: null }, page), true);
  assert.equal(trustedSender({ url: `${page}#/settings`, parent: null }, page), true, 'its own routes');
  assert.equal(trustedSender(null, page), false, 'a frame that is gone');
  assert.equal(trustedSender({ url: page, parent: {} }, page), false, 'a subframe, even of the same file');
  assert.equal(trustedSender({ url: 'https://example.com/', parent: null }, page), false, 'another site');
  assert.equal(trustedSender({ url: 'file:///tmp/evil.html', parent: null }, page), false, 'another local file');
  assert.equal(trustedSender({ url: `${page}.evil.html`, parent: null }, page), false, 'a look-alike path');
  assert.equal(trustedSender({ url: 'data:text/html,<p>x</p>', parent: null }, page), false);
});
