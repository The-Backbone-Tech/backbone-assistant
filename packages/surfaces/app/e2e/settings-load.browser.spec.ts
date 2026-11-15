// Real Settings components with a controlled bridge: no database, provider or grant is exercised.
import { expect as baseExpect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

const expect = baseExpect.configure({ timeout: 5000 });
test.setTimeout(30000);
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)),
    cacheDir: fileURLToPath(new URL('../node_modules/.vite-settings-load', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 }, plugins: [{
      name: 'settings-load-fixture',
      transformIndexHtml: html => html.replace('/src/main.tsx', '/settings-load-fixture.tsx'),
      resolveId: id => id === '/settings-load-fixture.tsx' ? '\0settings-load-fixture.tsx' : undefined,
      load: id => id === '\0settings-load-fixture.tsx' ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {ConnectorsSection} from '/src/components/settings/Connectors.tsx';
        import {AiToolsSection} from '/src/components/settings/AiTools.tsx';
        import {PluginsSection} from '/src/components/settings/Plugins.tsx';
        import '/src/styles.css';
        const components={connectors:ConnectorsSection,tools:AiToolsSection,plugins:PluginsSection};
        function Fixture(){const [visible,setVisible]=React.useState(true);window.fixture.show=setVisible;
          return visible?React.createElement(components[window.fixture.section]):null;}
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));` : undefined,
    }] });
  await server.listen(); url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

for (const section of ['connectors', 'tools', 'plugins'] as const) {
  test.describe(section, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(({ section }) => {
        const f = { section, fail: true, hold: false, label: 'Confirmed', calls: 0,
          pending: [] as { resolve: () => void; reject: () => void }[],
          listeners: new Set<(e: { topic: string }) => void>(), show: (_: boolean) => {},
          emit() { for (const listener of f.listeners) listener({ topic: section === 'plugins' ? 'memory' : section }); } };
        Object.assign(window, { fixture: f, backbone: { platform: 'linux',
          onEvent(listener: (e: { topic: string }) => void) { f.listeners.add(listener); return () => { f.listeners.delete(listener); }; },
          async call(method: string) {
            const target = section === 'connectors' ? 'connectors.list' : section === 'tools' ? 'tools.list' : 'plugins.parts';
            if (method !== target) throw new Error('Unexpected fixture call: ' + method);
            f.calls++;
            const value = section === 'connectors' ? { servers: [{ id: 'fixture', name: f.label, enabled: true, tools: [], state: 'ready', source: 'fixture', shown: 'notes', envNames: [], listedAt: '2026-11-14T00:00:00Z', egress: false }], held: [], egress: 'per-server' }
              : section === 'tools' ? { available: true, tools: [{ id: 'codex', name: f.label, state: 'connected', permission: { operations: ['outbox.write'], ceiling: 1, expiresAt: '2026-12-01T00:00:00Z' }, receipts: 0 }] }
              : [{ id: 'part', plugin: f.label, name: 'greet', kind: 'command', origin: 'claude', state: 'active', digest: 'fixture-digest' }];
            if (f.hold) return new Promise((resolve, reject) => f.pending.push({ resolve: () => resolve(value), reject: () => reject(new Error('Controlled late failure')) }));
            if (f.fail) throw new Error('Controlled inspection failure');
            return value;
          },
        } });
      }, { section });
    });

    test('initial failure is visible and Retry loads the actual list', async ({ page }) => {
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(url);
      await expect(page.getByRole('alert')).toContainText('could not be loaded', { timeout: 3000 });
      await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
      await expect(page.getByText(/No .*found/)).toHaveCount(0);
      await page.evaluate(() => { (window as any).fixture.fail = false; });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.locator('fieldset')).toContainText('Confirmed');
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('failed refresh retains labelled data and recovery controls until Retry succeeds', async ({ page }) => {
      await page.goto(url);
      await page.evaluate(() => { const f = (window as any).fixture; f.fail = false; f.emit(); });
      await expect(page.locator('fieldset')).toContainText('Confirmed');
      await page.evaluate(() => { const f = (window as any).fixture; f.fail = true; f.emit(); });
      await expect(page.getByRole('alert')).toContainText('Showing the last loaded list');
      await expect(page.locator('fieldset')).toContainText('Confirmed');
      const recovery = section === 'connectors' ? 'Turn off Confirmed' : section === 'tools' ? 'Disconnect' : 'Disable';
      await expect(page.getByRole('button', { name: recovery, exact: true })).toBeEnabled();
      await page.screenshot({ path: test.info().outputPath('refresh-failed.png') });
      await page.evaluate(() => { const f = (window as any).fixture; f.fail = false; f.label = 'Current'; });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.locator('fieldset')).toContainText('Current');
      await expect(page.locator('fieldset')).not.toContainText('Confirmed');
      await expect(page.locator('fieldset').getByRole('button').first()).toBeEnabled();
    });

    test('a late success and a late failure cannot replace the newer list', async ({ page }) => {
      await page.goto(url);
      await page.evaluate(() => { const f = (window as any).fixture; f.hold = true; f.label = 'Old'; f.emit(); f.emit(); });
      await expect.poll(() => page.evaluate(() => (window as any).fixture.pending.length)).toBe(2);
      await page.evaluate(() => { const f = (window as any).fixture; f.hold = false; f.fail = false; f.label = 'Newest'; f.emit(); });
      await expect(page.locator('fieldset')).toContainText('Newest');
      await page.evaluate(async () => { const f = (window as any).fixture; f.pending[0].resolve(); f.pending[1].reject(); await new Promise(resolve => setTimeout(resolve, 0)); });
      await expect(page.locator('fieldset')).toContainText('Newest');
      await expect(page.locator('fieldset')).not.toContainText('Old');
      await expect(page.getByRole('alert')).toHaveCount(0);
    });

    test('leaving the section releases its event listener and ignores its pending read', async ({ page }) => {
      await page.goto(url);
      await page.evaluate(() => { const f = (window as any).fixture; f.hold = true; f.emit(); });
      await expect.poll(() => page.evaluate(() => (window as any).fixture.pending.length)).toBe(1);
      await page.evaluate(() => { (window as any).fixture.show(false); });
      await expect.poll(() => page.evaluate(() => (window as any).fixture.listeners.size)).toBe(0);
      await page.evaluate(async () => { const f = (window as any).fixture; f.pending[0].resolve(); await new Promise(resolve => setTimeout(resolve, 0)); f.hold = false; f.fail = false; f.label = 'Reopened'; f.show(true); });
      await expect(page.locator('fieldset')).toContainText('Reopened');
      await expect.poll(() => page.evaluate(() => (window as any).fixture.listeners.size)).toBe(1);
    });
  });
}
