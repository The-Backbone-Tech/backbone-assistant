import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pieceUpgradeDialog } from '../electron/piece-upgrade.ts';

const piece = { id: 'io.github.albertoangulo/harness-codex', version: '0.0.1', digest: 'sha256:new', previous: { version: '0.0.0', digest: 'sha256:old' }, addedCapabilities: { planes: [], operations: ['native.account_tools'], effectClasses: ['6'], network: ['native-codex-account-tools-in-full'] } };
test('the widening dialog explains native account reach in plain words, once', () => {
  const dialog = pieceUpgradeDialog('Backbone', piece);
  assert.equal(dialog.message, "Backbone's Codex engine can now use the connectors, plugins and MCP servers of your own Codex app (mail, calendar, files) when a chat has Full access. Allow?");
  assert.deepEqual(dialog.buttons, ['Allow', "Don't allow"]);
  assert.equal(dialog.defaultId, 1); assert.equal(dialog.cancelId, 1);
  assert.doesNotMatch(dialog.message, /sha256|harness-codex|native.account/);
  assert.match(dialog.detail, /sha256:new/);
  assert.match(dialog.detail, /sending, changing and deleting .* without asking each time, also in scheduled and delegated work/);
  assert.match(dialog.detail, /holds no receipt/);
  assert.match(dialog.detail, /previous version/i);
});
test('other added capabilities are explained rather than hidden behind the native account wording', () => {
  const dialog = pieceUpgradeDialog('Backbone', { ...piece, addedCapabilities: { ...piece.addedCapabilities, planes: ['company'], operations: ['native.account_tools', 'workspace.delete_document'], network: ['example.test'], secrets: 'credential-store' } });
  assert.match(dialog.message, /company/); assert.match(dialog.message, /delete document/); assert.match(dialog.message, /example\.test/); assert.match(dialog.message, /credential store/);
});
test('a configured path update without added capabilities asks to allow its engine', () => {
  const dialog = pieceUpgradeDialog('Assistant', { ...piece, addedCapabilities: { planes: [], operations: [], effectClasses: [], network: [] } });
  assert.match(dialog.message, /Assistant.*updated.*Allow/); assert.doesNotMatch(dialog.message, /connectors/);
});

test('a withdrawn question cannot be mistaken for an allow', async () => {
  const { upgradeAnswer } = await import('../electron/piece-upgrade.ts');
  assert.equal(upgradeAnswer(0, false), true);
  assert.equal(upgradeAnswer(1, false), false);
  assert.equal(upgradeAnswer(0, true), false);
});


test('update window escapes content before placing it in HTML', async () => {
  const { upgradeQuestionPage } = await import('../electron/piece-upgrade.ts');
  const html = upgradeQuestionPage('<script>bad()</script>', 'A & B');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /A &amp; B/);
});
