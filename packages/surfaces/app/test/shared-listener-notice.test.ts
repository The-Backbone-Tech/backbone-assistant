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
    const failed = withCurrentAddress({ enabled: false, address: '192.168.1.9', port: 8443, addresses: ['10.0.0.4', '127.0.0.1'], notice });
    assert.equal(failed.address, '10.0.0.4');
    const html = renderToStaticMarkup(createElement(SharingPanel, { view: failed, busy: false, error: '', native: false, onToggle() {}, onAddress() {}, onPort() {} }));
    assert.match(html, /<input type="checkbox"(?![^>]*checked)/);
    assert.ok(html.includes(notice), 'the notice is shown');
    assert.ok(html.indexOf(notice) < html.indexOf('Computer address'), 'the notice sits beside the controls, before the address');
    assert.match(html, /<select[^>]*aria-label="Computer address"[^>]*(?<!disabled="")>/);
    assert.doesNotMatch(html.slice(html.indexOf('<select'), html.indexOf('</select>')), /192\.168\.1\.9/);
    const quiet = renderToStaticMarkup(createElement(SharingPanel, { view: { enabled: false, address: '10.0.0.4', port: 8443, addresses: ['10.0.0.4'] }, busy: false, error: '', native: false, onToggle() {}, onAddress() {}, onPort() {} }));
    assert.doesNotMatch(quiet, /role="status"/);
    assert.equal(withCurrentAddress({ enabled: false, address: '10.0.0.4', port: 8443, addresses: ['10.0.0.4'], notice }).address, '10.0.0.4');
  } finally {
    await server.close();
  }
});
