import { enableConnector } from '@backbone-next/platform/testing/connectors';
// The actual browser bridge can remove authority; granting it points the person to desktop main.
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { expect, test } from '@playwright/test';
import { startBridge, stopBridge } from './bridge';
import { connectorWorld } from './connector-world';

test('browser connector switches disable immediately and show the desktop requirement for both enables', async ({ page }) => {
  const home = freshDataHome('connectors-browser');
  const world = connectorWorld();
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  const host = createHost({ home, connectors: { env: world.toolEnv, sources: ['claude-code'] } });
  try {
    expect((await host.call('connectors.refresh', { serverId: 'claude-code:notes' })).ok).toBe(true);
    expect((await enableConnector(host, 'claude-code:notes')).ok).toBe(true);
    expect((await enableConnector(host, 'claude-code:notes', 'search')).ok).toBe(true);
    host.close(); await hostClosed(home);
    bridge = await startBridge(home, world.env);
    const enables: unknown[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api') && request.method() === 'POST') {
        const { method, args } = request.postDataJSON();
        if (method === 'connectors.set' && (args.enabled === true || args.tool?.enabled === true)) enables.push(args);
      }
    });
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Connected tools', exact: true }).click();
    const row = settings.getByTestId('connector-claude-code:notes');
    await row.getByRole('button', { name: 'Tools (1/12)', exact: true }).click();
    await row.getByRole('button', { name: 'Turn on its tools', exact: true }).click();
    await expect(row).toContainText('Turning a connector on is done by the person in the desktop app.');
    await row.getByRole('button', { name: 'Turn off search', exact: true }).click();
    await row.getByRole('button', { name: 'Turn off notes', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Turn on notes', exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Turn on notes', exact: true }).click();
    const detail = 'Turning a connector on is done by the person in the desktop app.';
    await expect(row).toContainText(detail);
    await row.getByRole('button', { name: 'Turn on search', exact: true }).click();
    const tool = row.getByLabel('What search does').locator('..').locator('..');
    await expect(tool).toContainText(detail);
    expect(enables).toEqual([]);
    await page.route('**/api', async (route) => {
      const { method } = route.request().postDataJSON();
      if (method === 'connectors.refresh' || method === 'connectors.set') {
        await route.fulfill({ json: { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'The server cancelled its handshake; nothing was changed.' } });
      } else await route.continue();
    });
    await row.getByRole('button', { name: 'List again', exact: true }).click();
    await expect(row).toContainText('The server cancelled its handshake; nothing was changed.');
    await row.getByLabel('What search does').selectOption('effect');
    await expect(tool).toContainText('The server cancelled its handshake; nothing was changed.');
    await expect(row.getByRole('button', { name: 'Turn on notes', exact: true })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Turn on search', exact: true })).toBeEnabled();
  } finally { host.close(); if (bridge) await stopBridge(bridge.proc); await removeDataHome(home); world.remove(); }
});


test('Held actions opens reviewed attachment bytes and shows file metadata instead of base64', async ({ page }) => {
  const home = freshDataHome('held-attachments'), world = connectorWorld();
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  const content = Buffer.from('Reviewed attachment.').toString('base64');
  const args = { to: 'person@example.com', subject: 'Reviewed files', body: 'See this exact file.',
    attachments: [{ filename: 'reviewed.txt', mime_type: 'text/plain', content },
      { filename: 'untrusted.html', mime_type: 'text/html', content: Buffer.from('<script>window.attachmentRan=true</script>').toString('base64') }] };
  // Renderer fixture only: no permission, Core receipt or outside send is fabricated as evidence.
  await page.route('**/api', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().method === 'connectors.list') {
      const response = await route.fetch(), view = await response.json();
      await route.fulfill({ json: { ...view, held: [{ effect: 'attachment-view', argsHash: 'reviewed-hash',
        serverId: 'claude-code:notes', serverName: 'notes', tool: 'send_note', state: 'waiting', args,
        statement: `Call send_note on notes with exactly: ${JSON.stringify(args)}`, detail: 'Waiting for the person.' }] } });
    } else await route.continue();
  });
  try {
    bridge = await startBridge(home, world.env);
    await page.goto(bridge.url); await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Connected tools', exact: true }).click();
    const card = settings.getByTestId('connector-call-attachment-view');
    await expect(card.getByTestId('held-attachment').first()).toContainText('reviewed.txt · text/plain · 20 bytes');
    await expect(card).not.toContainText(content);
    await expect(card).toContainText('reviewed-hash');
    await card.getByRole('button', { name: 'Open attachment reviewed.txt', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'reviewed.txt', exact: true });
    await expect(preview.getByLabel('Attachment text', { exact: true })).toHaveText('Reviewed attachment.');
    await preview.screenshot({ path: test.info().outputPath('held-attachment.png') });
    const download = page.waitForEvent('download');
    await preview.getByRole('link', { name: 'Save attachment', exact: true }).click();
    const saved = await download; expect(saved.suggestedFilename()).toBe('reviewed.txt');
    const stream = await saved.createReadStream(); const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('Reviewed attachment.'); await saved.delete();
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
    await card.getByRole('button', { name: 'Open attachment untrusted.html', exact: true }).click();
    const html = page.getByRole('dialog', { name: 'untrusted.html', exact: true });
    await expect(html.getByLabel('Attachment text', { exact: true })).toHaveText('<script>window.attachmentRan=true</script>');
    expect(await page.evaluate(() => 'attachmentRan' in window)).toBe(false);
    await html.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Permit', exact: true })).toBeVisible();
  } finally { if (bridge) await stopBridge(bridge.proc); await removeDataHome(home); world.remove(); }
});
