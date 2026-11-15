import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('Settings shows why sharing is off and offers a current address', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SharingPanel, withCurrentAddress } = await server.ssrLoadModule('/src/components/settings/SharedListener.tsx');
    const notice = 'The saved address is no longer available. Choose a current address to turn sharing on.';
    const failed = withCurrentAddress({ enabled: false, address: '192.168.1.9', port: 8443, addresses: ['10.0.0.4', '127.0.0.1'], engineRefusesColleagues: false, notice });
    assert.equal(failed.address, '10.0.0.4');
    const html = renderToStaticMarkup(createElement(SharingPanel, { view: failed, busy: false, error: '', onToggle() {}, onAddress() {}, onPort() {} }));
    assert.match(html, /<input type="checkbox"(?![^>]*checked)/);
    assert.ok(html.includes(notice), 'the notice is shown');
    assert.ok(html.indexOf(notice) < html.indexOf('Computer address'), 'the notice sits beside the controls, before the address');
    assert.match(html, /<select[^>]*aria-label="Computer address"[^>]*(?<!disabled="")>/);
    assert.doesNotMatch(html.slice(html.indexOf('<select'), html.indexOf('</select>')), /192\.168\.1\.9/);
    const quiet = renderToStaticMarkup(createElement(SharingPanel, { view: { enabled: false, address: '10.0.0.4', port: 8443, addresses: ['10.0.0.4'], engineRefusesColleagues: false }, busy: false, error: '', onToggle() {}, onAddress() {}, onPort() {} }));
    assert.doesNotMatch(quiet, /role="status"/);
    assert.equal(withCurrentAddress({ enabled: false, address: '10.0.0.4', port: 8443, addresses: ['10.0.0.4'], engineRefusesColleagues: false, notice }).address, '10.0.0.4');
  } finally {
    await server.close();
  }
});

test('Settings tells the owner, with sharing on or off, when the engine cannot answer colleagues', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SharingPanel } = await server.ssrLoadModule('/src/components/settings/SharedListener.tsx');
    const show = (view: object) => renderToStaticMarkup(createElement(SharingPanel, { view: { address: '10.0.0.4', port: 8443, addresses: ['10.0.0.4'], ...view }, busy: false, error: '', onToggle() {}, onAddress() {}, onPort() {} }));
    for (const enabled of [false, true]) {
      const extra = enabled ? { origin: 'https://10.0.0.4:8443', fingerprint: 'a'.repeat(64) } : {};
      const told = show({ enabled, engineRefusesColleagues: true, ...extra });
      assert.match(told, /data-testid="engine-notice"/);
      assert.match(told, /messages are refused until you configure a model for shared work/);
      assert.match(told, /Settings › AI and models/);
      assert.match(told, /close the app.*backbone model shared local.*open it again/);
      assert.match(told, /Shared work/);
      assert.match(told, /choose a key, a gateway or a local model/);
      assert.match(told, /Your own engine and model stay selected on this computer/);
      assert.doesNotMatch(told, /Your own engine stays selected/);
      assert.match(show({ enabled, engineRefusesColleagues: false, engineNotice: 'Shared engine could not load: fixture failure', ...extra }), /fixture failure/);
      assert.doesNotMatch(show({ enabled, engineRefusesColleagues: false, ...extra }), /engine-notice|messages are refused/);
    }
  } finally {
    await server.close();
  }
});
