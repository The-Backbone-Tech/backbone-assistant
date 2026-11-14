// Settings › Backup as a person meets it, on the browser bridge with the stub engine: the export goes
// only into a folder picked in the app's own picker (the bridge's stand-in, BACKBONE_BRIDGE_PICK),
// as a one-time ticket bound to the page; a path it names itself is refused. The export says what is
// never in it, and is checked file for file, with how to bring it into a new home.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, stopBridge } from './bridge';
import { api } from './journey';

const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };

async function opened(page: Page) {
  const home = freshDataHome('backup-settings');
  // Its real path: the export says where it went as the file system resolves it.
  const picked = realpathSync(mkdtempSync(join(tmpdir(), 'backbone-backup-e2e-')));
  process.env.BACKBONE_BRIDGE_PICK = picked;
  const bridge = await startBridge(home);
  delete process.env.BACKBONE_BRIDGE_PICK;
  await page.goto(bridge.url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  const p = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Ops', kind: 'folder' });
  const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId: p.value.id, text: 'Write a brief', attachments: [], settings, clientKey: 'first' });
  await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: sent.value.threadId })).value.summary.running).toBe(false);
  await page.reload();
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Backup' }).click();
  return { picked, section: dialog.getByTestId('backup'), end: async () => { await stopBridge(bridge.proc); await removeDataHome(home); rmSync(picked, { recursive: true, force: true }); } };
}

test('Settings › Backup exports only into the picked folder, says what it left out, and checks the export', async ({ page }) => {
  const { picked, section, end } = await opened(page);
  try {
    // The page cannot name a folder of its own, nor reuse a ticket it made up.
    const named = await api<{ ok: boolean; detail: string }>(page, 'backup.export', { to: join(picked, 'chosen-by-page') });
    expect(named.ok).toBe(false);
    expect((await api<{ ok: boolean }>(page, 'backup.export', { ticket: 'f'.repeat(64) })).ok).toBe(false);
    expect(readdirSync(picked)).toEqual([]);

    await expect(section.getByRole('button', { name: 'Export' })).toBeDisabled();
    await section.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(section.getByTestId('export-folder')).toContainText(join(picked, 'home-export-'));
    await section.getByRole('button', { name: 'Export' }).click();
    const made = section.getByTestId('backup-made');
    await expect(made).toContainText(`Exported to ${join(picked, 'home-export-')}`);
    await expect(made).toContainText('1 projects, 1 chats');
    await expect(made).toContainText('Never in it');
    await expect(made).toContainText('Credentials and keys');
    const [to] = readdirSync(picked).map((f) => join(picked, f));
    expect(existsSync(join(to, 'manifest.json'))).toBe(true);
    expect(existsSync(join(to, 'database'))).toBe(false);
    // The ticket was good once: another export needs another pick.
    await expect(section.getByRole('button', { name: 'Export' })).toBeDisabled();

    await expect(section.getByRole('textbox', { name: 'Backup folder' })).toHaveValue(to);
    await section.getByRole('button', { name: 'Check' }).click();
    const checked = section.getByTestId('backup-checked');
    await expect(checked).toContainText('Every file matches');
    await expect(checked).toContainText(`backbone restore "${to}" --home <new-data-folder> --dry-run`);

    writeFileSync(join(to, 'README.md'), 'changed\n');
    await section.getByRole('button', { name: 'Check' }).click();
    await expect(section.getByRole('alert')).toContainText('SHA-256');
    await expect(checked).toBeHidden();
  } finally { await end(); }
});
