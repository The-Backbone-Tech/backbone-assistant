// Real app renderer and Host, disposable data, real local shell commands. No model or external account.
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import type { Method, Receipt } from '@backbone-next/platform';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const value = <T,>(r: Receipt<T>) => { if (!r.ok) throw new Error(r.detail); return r.value; };
async function screenshot(page: Page, info: TestInfo, state: string) {
  const root = process.env.TERMINAL_STREAM_SCREENSHOTS;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  await page.screenshot({ path: join(root, `${info.project.name}-${state}.png`) });
}

test('a person streams, closes and reopens, stops, recalls, reruns known commands and sees every outcome and cap', async ({ page }, info) => {
  const home = freshDataHome('terminal-ui');
  let host = createHost({ home, harness: 'harness-stub' });
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const calls: string[] = []; let lostReply = false, refuseReads = false, reads = 0;
  await page.exposeFunction('terminalHostCall', async (method: Method, args: unknown) => {
    if (method === 'terminal.start') calls.push((args as { command: string }).command);
    if (method === 'terminal.list') reads++;
    if (method === 'terminal.list' && refuseReads) throw new Error('Controlled read outage');
    const result = await host.call(method, args as never);
    if (method === 'terminal.start' && (args as { command: string }).command.includes('lost reply') && !lostReply) { lostReply = true; refuseReads = true; throw new Error('Controlled lost acknowledgement after dispatch'); }
    return result;
  });
  await page.addInitScript(() => {
    const w = window as any;
    w.backbone = { platform: 'linux', setTheme() {}, call: (m: string, a: unknown) => w.terminalHostCall(m, a), onEvent() { return () => {}; } };
  });
  let projectId = '';
  try {
    projectId = value(await host.call('projects.create', { name: 'Terminal journey', kind: 'folder' })).id;
    const prefs = await host.call('viewer.get', {});
    await host.call('viewer.put', { prefs: { ...prefs, theme: info.project.use.colorScheme === 'dark' ? 'dark' : 'light', selectedProjectId: projectId, pane: { open: true, active: 'terminal', tabs: [{ id: 'terminal', kind: 'terminal' }] } } });
    await page.goto(server.resolvedUrls!.local[0]);
    const input = page.getByRole('textbox', { name: 'Terminal command' });
    await expect(input).toBeEnabled();
    await expect(page.getByText(/^Folder:/)).toContainText('/projects/', { timeout: 5000 });
    const command = 'printf "first output\\n"; sleep 30; printf "last output\\n"';
    await input.fill(command); await input.press('Enter');
    await expect(page.locator('pre').filter({ hasText: 'first output' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Running…' })).toBeVisible();
    await screenshot(page, info, 'running');
    await page.getByRole('button', { name: 'Close Terminal', exact: true }).click();
    await expect(page.locator('[data-pane-toggle]')).toBeFocused({ timeout: 5000 });
    await page.keyboard.press('Control+Backquote');
    await expect(input).toBeEnabled();
    await expect(input).toBeFocused();
    await expect(page.locator('pre').filter({ hasText: 'first output' })).toBeVisible();
    expect(calls).toEqual([command]);
    await page.getByRole('button', { name: 'Close pane', exact: true }).click();
    await expect(page.locator('[data-pane-toggle]')).toBeFocused({ timeout: 5000 });
    await page.keyboard.press('Control+Backquote');
    await expect(input).toBeFocused();
    await input.fill('a second line'); await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('already running');
    expect(calls).toHaveLength(1);
    await input.press('Control+c');
    await expect(page.getByRole('status').filter({ hasText: 'Stopped by you' })).toBeVisible();
    await expect(page.getByRole('alert'), 'Stop clears the earlier already-running refusal').toHaveCount(0, { timeout: 2000 });
    await screenshot(page, info, 'stopped');
    await input.fill('draft'); await input.press('ArrowUp'); await expect(input).toHaveValue(command);
    await input.press('ArrowDown'); await expect(input).toHaveValue('draft');
    await input.fill('printf "<b>literal output</b>\\n"'); await input.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Succeeded' })).toBeVisible();
    await expect(page.locator('pre').filter({ hasText: '<b>literal output</b>' })).toBeVisible();
    await expect(page.locator('pre b')).toHaveCount(0);
    await screenshot(page, info, 'succeeded');
    const known = page.getByTestId('terminal-block').filter({ hasText: '✓ Succeeded' }).last();
    await known.getByRole('button', { name: 'Run again' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Succeeded' })).toHaveCount(2);
    await input.fill('exit 7'); await input.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'exit 7' })).toBeVisible();
    await screenshot(page, info, 'failed');
    await input.fill('printf "button stop\\n"; sleep 30'); await input.press('Enter');
    await expect(page.locator('pre').filter({ hasText: 'button stop' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Stopped by you' })).toHaveCount(2);
    await input.fill('printf "before restart\\n"; sleep 1'); await input.press('Enter');
    await expect(page.locator('pre').filter({ hasText: 'before restart' })).toBeVisible();
    host.close(); await hostClosed(home); host = createHost({ home, harness: 'harness-stub' });
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'Stopped: the app closed' })).toBeVisible();
    await screenshot(page, info, 'stopped-app-closed');
    const cwd = value(await host.call('terminal.list', { projectId })).cwd;
    host.close(); await hostClosed(home);
    const terminalModule = new URL('../../../platform/src/composition/terminal-stream.ts', import.meta.url).href;
    const crashed = spawn(process.execPath, ['--input-type=module', '-e', `import {createTerminal} from ${JSON.stringify(terminalModule)}; const terminal=createTerminal({home:process.argv[1],directory:()=>process.argv[2],exists:()=>true,changed(){}}); await terminal.start({projectId:process.argv[3],command:'echo before crash; sleep 60',clientKey:'ui-crash'}); await new Promise(r=>setTimeout(r,1200)); console.log('ready'); setInterval(()=>{},1000);`, home, cwd, projectId], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => { crashed.stdout!.once('data', () => resolve()); crashed.once('error', reject); crashed.once('exit', () => reject(new Error('Crash fixture exited before readiness'))); });
    } finally { crashed.kill('SIGKILL'); await new Promise<void>(resolve => crashed.once('close', () => resolve())); }
    host = createHost({ home, harness: 'harness-stub' });
    await page.reload();
    await expect(page.getByTestId('terminal-tab')).toContainText('Still running from before the app stopped');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await screenshot(page, info, 'still-running-after-restart');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    renameSync(cwd, cwd + '-temporarily-unavailable');
    try {
      await input.fill('echo missing folder'); await input.press('Enter');
      await expect(page.getByRole('status').filter({ hasText: 'Not known' })).toBeVisible();
    } finally { renameSync(cwd + '-temporarily-unavailable', cwd); }
    await expect(page.getByTestId('terminal-block').filter({ hasText: '? Not known' }).getByRole('button', { name: 'Run again' })).toHaveCount(0);
    expect(calls.filter(c => c.includes('before restart'))).toHaveLength(1);
    await screenshot(page, info, 'not-known');
    await input.fill('head -c 100000 /dev/zero | tr "\\000" x; yes line | head -n 3000'); await input.press('Enter');
    await expect(page.getByText(/output bytes and .*line breaks left out/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await screenshot(page, info, 'caps');
    await input.fill('printf watching; sleep 30'); await input.press('Enter');
    await expect(page.locator('pre').filter({ hasText: 'watching' })).toBeVisible();
    const history = page.getByLabel('Command history', { exact: true }), beforeReads = reads;
    await history.evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => reads).toBeGreaterThan(beforeReads + 2);
    expect(await history.evaluate(el => el.scrollTop), 'reading an earlier block survives fresh snapshots').toBe(0);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await input.fill('printf "lost reply\\n"; sleep 1'); await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('unconfirmed');
    await expect(input).toHaveValue('printf "lost reply\\n"; sleep 1');
    expect(calls.filter(c => c.includes('lost reply'))).toHaveLength(1);
    refuseReads = false;
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(page.locator('pre').filter({ hasText: 'lost reply' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Not known' })).toHaveCount(1);
    expect(calls.filter(c => c.includes('lost reply'))).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'Not known' })).toBeVisible();
    expect(calls.filter(c => c.includes('before restart'))).toHaveLength(1);
  } finally {
    refuseReads = false;
    const view = await host.call('terminal.list', { projectId }).catch(() => undefined);
    if (view?.ok) for (const b of view.value.commands) if (b.status === 'running') {
      await host.call('terminal.stop', { projectId, id: b.id });
      await expect.poll(async () => value(await host.call('terminal.list', { projectId })).commands.find(c => c.id === b.id)?.status).not.toBe('running');
    }
    await page.close(); host.close(); await hostClosed(home); await removeDataHome(home); await server.close();
  }
});
