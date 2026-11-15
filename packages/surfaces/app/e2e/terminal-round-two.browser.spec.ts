// The actual renderer with controlled receipts; OS custody is proved by terminal-stream.test.ts.
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function shot(page: Page, info: TestInfo, state: string) {
  const root = process.env.TERMINAL_STREAM_SCREENSHOTS;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  await page.screenshot({ path: join(root, `${info.project.name}-${state}.png`) });
}
async function fixture(page: Page, state: 'running' | 'corrupt' | 'closed' = 'running', initialActive = true) {
  const baseline = process.env.TERMINAL_ROUND_TWO_BASELINE;
  const server = await createServer({ configFile: false, plugins: [
    ...(baseline ? [{ name: 'round-one-evidence', enforce: 'pre' as const, load(id: string) { if (id.endsWith('/src/components/tabs/TerminalTab.tsx')) return readFileSync(resolve(baseline === 'copy' ? '../../../evidence/terminal-stream-20261115/round-two/TerminalTab.before-copy.tsx' : '../../../evidence/terminal-stream-20261115/round-two/TerminalTab.round-one.tsx'), 'utf8'); } }] : []),
    react(), tailwindcss(),
  ], server: { host: '127.0.0.1', port: 0 }, appType: 'custom' });
  await server.listen();
  const address = server.httpServer!.address() as { port: number };
  await page.route(`http://127.0.0.1:${address.port}/`, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.evaluate(async ({ state, initialActive }) => {
    await import('/src/styles.css' as string);
    document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches);
    document.getElementById('root')!.style.height = '100vh';
    const w = window as any;
    const block = { id: 'block', clientKey: 'key', command: 'sleep 60', output: 'select this output', code: null, cwd: '/project', status: state === 'closed' ? 'failed' : 'running', detail: state === 'closed' ? 'Stopped: the app closed' : 'Still running from before the app stopped. Further output is unavailable; Stop is available.', startedAt: new Date().toISOString(), signals: [], omittedBytes: 0, omittedLines: 0 };
    w.state = { corrupt: state === 'corrupt', commands: state === 'corrupt' ? [] : [block], reads: 0, stops: 0, starts: 0, clears: 0 };
    Object.assign(w, { $RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type, __vite_plugin_react_preamble_installed__: true });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { w.state.copied = text; } } });
    w.backbone = { platform: 'linux', onEvent() { return () => {}; }, call: async (method: string) => {
      if (method === 'terminal.list') { w.state.reads++; if (w.state.corrupt) return { ok: false, outcome: 'REFUSED', reason: 'NOT_AVAILABLE', detail: 'The terminal record for this project cannot be read; nothing was run. Clear terminal history to continue.' }; }
      if (method === 'terminal.start') { w.state.starts++; return { ok: false, outcome: 'REFUSED', reason: 'NOT_AVAILABLE', detail: 'Controlled start refusal' }; }
      if (method === 'terminal.stop') { w.state.stops++; w.state.commands[0].status = 'failed'; w.state.commands[0].detail = 'Stopped by you'; return { ok: true, value: w.state.commands[0] }; }
      if (method === 'terminal.clear') { w.state.clears++; w.state.corrupt = false; w.state.commands = w.state.commands.filter((b: any) => b.status === 'running'); }
      return { ok: true, value: { cwd: '/project', historyKey: 'epoch', commands: w.state.commands, omittedCommands: 0 } };
    } };
    // IPC delivers snapshots; the fixture must not mutate React's current view in place.
    const originalCall = w.backbone.call;
    w.backbone.call = async (method: string, args: unknown) => structuredClone(await originalCall(method, args));
    const React = (await import('/@id/react' as string)).default;
    const { createRoot } = (await import('/@id/react-dom/client' as string)).default;
    const { TerminalTab } = await import('/src/components/tabs/TerminalTab.tsx' as string);
    const root = createRoot(document.getElementById('root'));
    w.renderTerminal = (active: boolean) => root.render(React.createElement(TerminalTab, { projectId: 'p', active }));
    w.renderTerminal(initialActive);
    w.remountTerminal = () => root.render(React.createElement(TerminalTab, { projectId: 'p', active: true, key: 'remount' }));
  }, { state, initialActive });
  await expect(page.getByRole('textbox', { name: 'Terminal command' })).toBeVisible();
  return server;
}

test('visible running terminals poll; hidden and idle terminals do not; refused text survives', async ({ page }, info) => {
  const server = await fixture(page);
  try {
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).state.reads)).toBeGreaterThan(2);
    await page.evaluate(() => (window as any).renderTerminal(false));
    await page.waitForTimeout(100);
    const hidden = await page.evaluate(() => (window as any).state.reads);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => (window as any).state.reads)).toBe(hidden);
    await page.evaluate(() => (window as any).renderTerminal(true));
    await expect.poll(() => page.evaluate(() => (window as any).state.reads)).toBeGreaterThan(hidden);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Stopped by you' })).toBeVisible();
    await page.waitForTimeout(300);
    const idle = await page.evaluate(() => (window as any).state.reads);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => (window as any).state.reads)).toBe(idle);
    const input = page.getByRole('textbox', { name: 'Terminal command' });
    await input.fill('keep this refused command'); await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('Controlled start refusal');
    await expect(input).toHaveValue('keep this refused command');
    expect(await page.evaluate(() => (window as any).state.starts)).toBe(1);
  } finally { await page.close(); await server.close(); }
});

test('corrupt history offers the shared confirmation, Cancel and a usable cleared terminal', async ({ page }, info) => {
  const server = await fixture(page, 'corrupt');
  try {
    await expect(page.getByRole('alert')).toContainText('cannot be read');
    await expect(page.getByText('Run a command in this project’s folder.', { exact: true })).toHaveCount(0, { timeout: 1500 });
    await expect(page.getByRole('button', { name: 'Clear terminal history', exact: true })).toBeVisible({ timeout: 1500 });
    await shot(page, info, 'corrupt-record-with-clear');
    await page.getByRole('button', { name: 'Clear terminal history', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await expect(page.getByRole('dialog')).toContainText('A command left from before a crash can no longer be stopped from here.');
    await shot(page, info, 'clear-confirmation');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as any).state.clears)).toBe(0);
    await expect(page.getByRole('button', { name: 'Clear terminal history', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Clear terminal history', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clear terminal history', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Terminal command' })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).state.clears)).toBe(1);
  } finally { await page.close(); await server.close(); }
});

test('a clean-close block says the app closed', async ({ page }, info) => {
  const server = await fixture(page, 'closed');
  try {
    await expect(page.getByRole('status').filter({ hasText: 'Stopped: the app closed' })).toBeVisible();
    await shot(page, info, 'stopped-app-closed');
  } finally { await page.close(); await server.close(); }
});

test('Ctrl+C copies a selection and stops only without a selection', async ({ page }) => {
  const server = await fixture(page);
  try {
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Terminal command' })).toBeFocused();
    await page.locator('pre').evaluate(el => { const target = el.closest('[data-testid="terminal-tab"]') as HTMLElement; target.tabIndex = 0; target.focus(); const range = document.createRange(); range.selectNodeContents(el); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); });
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('select this output');
    await page.keyboard.press('Control+c');
    expect(await page.evaluate(() => (window as any).state.stops)).toBe(0);
    expect(await page.evaluate(() => (window as any).state.copied)).toBe('select this output');
    await page.evaluate(() => window.getSelection()!.removeAllRanges());
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => (window as any).state.stops)).toBe(1);
    await expect(page.getByRole('status').filter({ hasText: 'Stopped by you' })).toBeVisible();
  } finally { await page.close(); await server.close(); }
});

test('a recovered command says it is still running after restart', async ({ page }, info) => {
  const server = await fixture(page);
  try {
    await expect(page.getByTestId('terminal-tab')).toContainText('Still running from before the app stopped', { timeout: 1500 });
    await shot(page, info, 'still-running-after-restart');
  } finally { await page.close(); await server.close(); }
});

test('an idle visible terminal reads once and stops polling', async ({ page }) => {
  const server = await fixture(page, 'closed');
  try {
    await expect(page.getByRole('status').filter({ hasText: 'Stopped: the app closed' })).toBeVisible();
    const reads = await page.evaluate(() => (window as any).state.reads);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => (window as any).state.reads)).toBe(reads);
  } finally { await page.close(); await server.close(); }
});


test('terminal details are said once, collapse by keyboard and leave the folder on one line', async ({ page }, info) => {
  const server = await fixture(page, 'running', false);
  try {
    expect(await page.evaluate(() => localStorage.getItem('terminal-details-seen'))).toBeNull();
    await page.evaluate(() => (window as any).renderTerminal(true));
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    const details = page.getByRole('button', { name: 'Terminal details', exact: true });
    await expect(details).toHaveAttribute('aria-expanded', 'true', { timeout: 5000 });
    await expect(page.getByText('Interactive programs are not supported yet.', { exact: false })).toBeVisible();
    await details.focus(); await details.press('Enter');
    await expect(details).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: 'Clear terminal history', exact: true })).toBeHidden();
    await expect(page.getByText('Stop (Ctrl+C):', { exact: false })).toHaveCount(0);
    const folder = page.getByText('Folder:', { exact: false });
    expect(await folder.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('nowrap');
    await shot(page, info, 'header');
    await page.evaluate(() => { (window as any).state.commands[0].detail = 'Stop could not confirm the process right now; press Stop again to try again.'; });
    await expect(page.getByTestId('terminal-tab')).toContainText('Stop could not confirm');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await shot(page, info, 'stop-could-not-confirm');
    await page.evaluate(() => (window as any).remountTerminal());
    await expect(details).toHaveAttribute('aria-expanded', 'false');
    await details.press('Enter');
    await expect(page.getByRole('button', { name: 'Clear terminal history', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).focus();
    await expect(page.getByRole('tooltip')).toContainText('interrupt the process group');
  } finally { await page.close(); await server.close(); }
});
