import assert from 'node:assert/strict';
import { test, expect } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

test('unconfirmed terminal outcomes keep the command without repeating it', async ({ page }) => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0, strictPort: false }, appType: 'custom' });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await page.route(`http://127.0.0.1:${address.port}/`, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.evaluate(async () => {
      const calls: string[] = [];
      Object.assign(window, { $RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type, __vite_plugin_react_preamble_installed__: true, calls, backbone: { call: async (_method: string, args: { command: string }) => {
        calls.push(args.command);
        if (calls.length === 1) throw new Error('lost response');
        if (calls.length === 3) return { ok: false, reason: 'NOT_FOUND', outcome: 'REFUSED', detail: 'Command refused' };
        if (calls.length === 4) return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'UNKNOWN', detail: 'Command outcome unknown' };
        return { ok: true, value: { command: args.command, output: 'ok', code: 0 } };
      } } });
      const [reactPath, domPath, terminalPath] = ['/@id/react', '/@id/react-dom/client', '/src/components/tabs/TerminalTab.tsx'];
      const React = (await import(reactPath)).default;
      const { createRoot } = (await import(domPath)).default;
      const { TerminalTab } = await import(terminalPath);
      createRoot(document.getElementById('root')!).render(React.createElement(TerminalTab, { projectId: 'project' }));
    });
    const input = page.getByRole('textbox', { name: 'Terminal command' });
    await input.fill('first command');
    await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('outcome is unconfirmed', { timeout: 3000 });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('first command');
    assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: string[] }).calls), ['first command']);
    await input.fill('second command');
    await input.press('Enter');
    await expect(page.getByTestId('terminal-tab')).toContainText('ok');
    assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: string[] }).calls), ['first command', 'second command']);
    await input.fill('third command');
    await input.press('Enter');
    await expect(page.getByTestId('terminal-tab')).toContainText('Command refused');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('terminal-tab')).not.toContainText('exit timeout');
    assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: string[] }).calls), ['first command', 'second command', 'third command']);
    await input.fill('fourth command');
    await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('outcome is unconfirmed', { timeout: 3000 });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('fourth command');
    assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: string[] }).calls), ['first command', 'second command', 'third command', 'fourth command']);
  } finally {
    await page.close();
    await server.close();
  }
});
