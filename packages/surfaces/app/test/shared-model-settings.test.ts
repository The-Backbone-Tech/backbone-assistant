import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('shared work has its own Pi route and reuses local and sealed-key controls', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { SharedModelRoute } = await server.ssrLoadModule('/src/components/settings/ModelRoute.tsx');
    const settings = { harness: 'Codex', active: { label: 'Personal route', model: 'personal' }, shared: { harness: 'Pi', active: { label: 'Team local route', model: 'shared' }, local: null, own: null, gateway: null } };
    const html = renderToStaticMarkup(createElement(SharedModelRoute, { settings, onChange() {} }));
    assert.match(html, /Shared work/);
    assert.match(html, /Pi · Team local route/);
    assert.match(html, /Your own engine and model stay selected/);
    assert.match(html, /Shared work: your own key/);
    assert.match(html, /Shared work: gateway/);
    assert.match(html, /Shared local models/);
    assert.match(html, /used for colleagues and for your own sessions from other computers/i);
    assert.match(html, /other computers, including project files you open from them/i);
    assert.match(html, /stored shared API keys are kept/i);
    const failed = renderToStaticMarkup(createElement(SharedModelRoute, { settings: { ...settings, shared: { ...settings.shared, hint: 'Shared engine could not load: fixture load failure.' } }, onChange() {} }));
    assert.match(failed, /fixture load failure/);
    assert.doesNotMatch(html, /Personal route|Codex model/);
    const empty = renderToStaticMarkup(createElement(SharedModelRoute, { settings: { harness: 'Codex' }, onChange() {} }));
    assert.match(empty, /Not configured/);
  } finally { await server.close(); }
});
