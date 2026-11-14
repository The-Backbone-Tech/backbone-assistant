import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// The app on a home the daemon holds: one owner per home, so the app says who holds it and how to
// free it, instead of a window that half works. The daemon is the real one, run from the CLI.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startBridge, stopBridge } from './bridge';

const cli = join(import.meta.dirname, '../../cli/src/main.ts');

test('a home the daemon holds opens to a page that says so, with how to free it', async ({ page }) => {
  const home = freshDataHome('held');
  const daemon = spawn(process.execPath, [cli, 'daemon', 'run'], { env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub' }, stdio: 'ignore' });
  try {
    await expect.poll(() => existsSync(join(home, 'daemon.json')), { timeout: TEST_HANG_MS }).toBe(true);
    const bridge = await startBridge(home);
    try {
      await page.goto(bridge.url);
      const held = page.getByTestId('home-held');
      await expect(held).toBeVisible({ timeout: TEST_HANG_MS });
      await expect(held).toContainText('background service');
      await expect(held).toContainText(`pid ${daemon.pid}`);
      await expect(held).toContainText('backbone daemon uninstall');
      await page.screenshot({ path: '../../../evidence/l7-distribution/home-held.png' });
    } finally {
      await stopBridge(bridge.proc);
    }
  } finally {
    await new Promise((r) => { daemon.once('exit', r); daemon.kill('SIGTERM'); });
    await removeDataHome(home);
  }
});
