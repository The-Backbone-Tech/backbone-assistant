// Screen evidence only. The platform suite supplies fake OAuth and servers.
// Native sign-in still requires installed-app qualification.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { toolWorld } from '@backbone-next/platform/testing/tools';
import { expect, test } from '@playwright/test';
import { startBridge, stopBridge } from './bridge';

test('the catalogue shows four providers and configuration needs while browser grants stay closed', async ({ page }) => {
  const home = freshDataHome('catalogue-screen'), world = toolWorld({ seed: false });
  const bridge = await startBridge(home, world.env);
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Connected tools', exact: true }).click();
    const catalogue = settings.getByRole('region', { name: 'Connector catalogue' });
    await expect(catalogue.getByRole('button', { name: /^Connect / })).toHaveCount(4);
    await expect(catalogue.getByTestId('catalogue-calendar')).toContainText('workspace-mcp 2.4.1');
    await expect(catalogue.getByTestId('catalogue-drive')).toContainText('workspace-mcp 2.4.1');
    await expect(catalogue.getByTestId('catalogue-github')).toContainText('github-mcp-server 2.1.0');
    await expect(catalogue.getByTestId('catalogue-slack')).toContainText('needs a Slack app');
    await catalogue.getByLabel('Google Calendar permissions').selectOption('reads-and-effects');
    await catalogue.getByRole('button', { name: 'Connect Google Calendar', exact: true }).click();
    await expect(catalogue.getByTestId('catalogue-calendar').getByRole('status')).toContainText('desktop app');
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await stopBridge(bridge.proc); await removeDataHome(home); world.remove(); }
});
