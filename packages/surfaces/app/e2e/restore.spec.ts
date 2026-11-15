// Settings › Backup › Restore from a backup, as a person meets it, on the browser bridge with a real backup
// made from a throwaway data folder: the preview says what is true, the restore goes into a new folder and the
// restored folder opens with the work, a place that holds something or is the current data folder is refused
// before a write, a restore that fails part-way says so with the folder, the person can leave and come back, and
// the whole way is reachable by keyboard. The native pickers are stood in by the bridge's own (see server/bridge.ts).
import { removeDataHome } from '@backbone-next/platform/composition';
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { breakable, makeBackup, openBackup, readRestored } from './restore-world';

const dialogOf = (page: Page) => page.getByTestId('restore-dialog');

/** Moves focus with Tab until the control named `name` has it: a person without a pointer reaches it the same way. */
async function tabTo(page: Page, name: RegExp | string, limit = 60) {
  const seen: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return (a?.getAttribute('aria-label') || a?.textContent || '').trim(); });
    if (typeof name === 'string' ? label === name : name.test(label)) return;
    seen.push(label.slice(0, 40));
  }
  throw new Error(`Tab never reached ${name}. Focus went through: ${seen.join(' | ')}`);
}

test('the preview says what comes in and what does not, and the restore goes into a new data folder that opens with the work', async ({ page }) => {
  const backup = await makeBackup();
  const world = await openBackup(page, { backup: backup.folder });
  let target = '';
  try {
    await world.section.getByRole('button', { name: 'Restore from a backup…' }).click();
    const dialog = dialogOf(page);
    await expect(dialog).toContainText('Step 1 of 4: Backup');
    await dialog.getByRole('button', { name: 'Choose backup folder…' }).click();

    // The preview (the dry run): the real counts, and only what is true of what stays out.
    await expect(dialog).toContainText('Step 2 of 4: Preview');
    await expect(dialog.getByTestId('restore-from')).toHaveText(backup.folder);
    const comes = dialog.getByTestId('restore-comes');
    await expect(comes).toContainText(/2 projects, with \d+ documents? \(\d+ versions? in all\)/);
    await expect(comes).toContainText('1 conversation, as documents to read');
    await expect(dialog.getByTestId('restore-stays')).toContainText('No credential');
    await expect(dialog.getByTestId('restore-stays')).toContainText('No permission');
    await expect(dialog.getByTestId('restore-stays')).toContainText('No schedule or running work');
    expect(readdirSync(join(world.home, '..')).filter((n) => n.includes('restored'))).toEqual([]);

    // Where: a new folder beside the current one, with its path shown, never the current one.
    await dialog.getByRole('button', { name: 'Choose where it goes' }).click();
    await expect(dialog).toContainText('Step 3 of 4: Place');
    const place = dialog.getByTestId('restore-place');
    await expect(place).toContainText('-restored-');
    target = (await place.textContent())!;
    expect(target).not.toBe(world.home);
    await expect(dialog).toContainText(`keeps using ${world.home}`);
    expect(existsSync(target), 'nothing is made until Restore').toBe(false);

    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(dialog.getByTestId('restore-done')).toBeVisible();
    await expect(dialog.getByTestId('restore-where')).toHaveText(target);
    await expect(dialog.getByTestId('restore-done')).toContainText('BACKBONE_HOME');
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeVisible();

    // The restored folder opens, and holds the work: read through the platform api on a host opened on it.
    const restored = await readRestored(target);
    expect(restored.projects).toEqual(['Harbor', 'Ledger', 'Restored history']);
    expect(restored.documents).toContain('Harbor/Harbor notes.md');
    expect(restored.documents).toContain('Ledger/Ledger notes.md');

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(world.section.getByTestId('restore-status')).toHaveCount(0);
  } finally { await world.end(); if (target) await removeDataHome(target); await backup.end(); }
});

test('a place that holds something, and the current data folder, are refused before anything is written', async ({ page }) => {
  const backup = await makeBackup(['Harbor']);
  // The place picker, in this journey, answers with the current data folder itself.
  const world = await openBackup(page, { backup: backup.folder, parent: 'current' });
  const cleanup: string[] = [];
  try {
    await world.section.getByRole('button', { name: 'Restore from a backup…' }).click();
    const dialog = dialogOf(page);
    await dialog.getByRole('button', { name: 'Choose backup folder…' }).click();
    await dialog.getByRole('button', { name: 'Choose where it goes' }).click();
    const place = dialog.getByTestId('restore-place');
    await expect(place).toContainText('-restored-');
    const target = (await place.textContent())!;
    cleanup.push(target);

    // The current data folder as the chosen place: a new folder inside it is not offered, and the shown place stays.
    const before = readdirSync(world.home);
    await dialog.getByRole('button', { name: 'Choose another place…' }).click();
    await expect(dialog.getByTestId('restore-problem')).toContainText('the data folder this app is using now');
    await expect(place).toHaveText(target);
    expect(readdirSync(world.home)).toEqual(before);

    // Something lands in the shown folder after it was shown: the restore refuses, touches nothing, and offers a new one.
    mkdirSync(target);
    writeFileSync(join(target, 'mine.txt'), 'the person\'s own file');
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(dialog.getByTestId('restore-problem')).toContainText('not a new, empty data folder');
    expect(readdirSync(target)).toEqual(['mine.txt']);
    await expect(place).not.toHaveText(target);
    await expect(place).toContainText('-restored-');
    await expect(dialog.getByTestId('restore-done')).toHaveCount(0);
    expect(readdirSync(target)).toEqual(['mine.txt']);
  } finally { await world.end(); for (const folder of cleanup) rmSync(folder, { recursive: true, force: true }); await backup.end(); }
});

test('a restore that stops part-way says the new data folder holds part of the export, with its path, and is not called finished', async ({ page }) => {
  const backup = await makeBackup(['Harbor', 'Ledger']);
  const broken = breakable(backup.folder, backup.scratch);
  const world = await openBackup(page, { backup: broken });
  let target = '';
  try {
    await world.section.getByRole('button', { name: 'Restore from a backup…' }).click();
    const dialog = dialogOf(page);
    await dialog.getByRole('button', { name: 'Choose backup folder…' }).click();
    await dialog.getByRole('button', { name: 'Choose where it goes' }).click();
    await expect(dialog.getByTestId('restore-place')).toContainText('-restored-');
    target = (await dialog.getByTestId('restore-place').textContent())!;
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    const refused = dialog.getByTestId('restore-refused');
    await expect(refused).toBeVisible();
    await expect(refused).toContainText('The restore did not finish.');
    await expect(refused).toContainText('holds part of the backup');
    await expect(dialog.getByTestId('restore-where')).toHaveText(target);
    await expect(dialog.getByTestId('restore-done')).toHaveCount(0);
    expect(existsSync(target), 'the part that came in is kept, not hidden').toBe(true);

    // Closing the dialog does not lose it: Settings says so, and the dialog shows the same again.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(world.section.getByTestId('restore-status')).toContainText(`The last restore did not finish: ${target}`);
    await world.section.getByRole('button', { name: 'View restore' }).click();
    await expect(dialogOf(page).getByTestId('restore-refused')).toContainText('holds part of the backup');
    await dialogOf(page).getByRole('button', { name: 'Start again' }).click();
    await expect(dialogOf(page)).toContainText('Step 1 of 4: Backup');
  } finally { await world.end(); if (target) await removeDataHome(target); await backup.end(); }
});

test('the person can leave while it restores and find the result when they come back', async ({ page }) => {
  const backup = await makeBackup(['Harbor']);
  const world = await openBackup(page, { backup: backup.folder });
  let target = '';
  try {
    await world.section.getByRole('button', { name: 'Restore from a backup…' }).click();
    const dialog = dialogOf(page);
    await dialog.getByRole('button', { name: 'Choose backup folder…' }).click();
    await dialog.getByRole('button', { name: 'Choose where it goes' }).click();
    await expect(dialog.getByTestId('restore-place')).toContainText('-restored-');
    target = (await dialog.getByTestId('restore-place').textContent())!;
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(dialog.getByRole('status', { name: 'Restoring' })).toBeVisible();
    await expect(dialog).toContainText('You can close this window');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    // Leaving Settings altogether and coming back.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Backup' }).click();
    const section = page.getByRole('dialog', { name: 'Settings' }).getByTestId('backup');
    await expect(section.getByTestId('restore-status')).toContainText(target);
    await expect(section.getByTestId('restore-status')).toContainText('The last restore finished');
    await section.getByRole('button', { name: 'View restore' }).click();
    await expect(dialogOf(page).getByTestId('restore-done')).toBeVisible();
    await expect(dialogOf(page).getByTestId('restore-where')).toHaveText(target);
  } finally { await world.end(); if (target) await removeDataHome(target); await backup.end(); }
});

test('where restore is unavailable, the reason is shown in place of the button', async ({ page }) => {
  const backup = await makeBackup(['Harbor']);
  const world = await openBackup(page, { backup: backup.folder, env: { BACKBONE_BRIDGE_RESTORE_UNAVAILABLE: 'This app is set up by your company, which keeps data folders under its own control.' } });
  try {
    await expect(world.section.getByTestId('restore-unavailable')).toContainText('set up by your company');
    await expect(world.section.getByRole('button', { name: 'Restore from a backup…' })).toHaveCount(0);
  } finally { await world.end(); await backup.end(); }
});

test('the terminal way stays, under From a terminal', async ({ page }) => {
  const backup = await makeBackup(['Harbor']);
  const world = await openBackup(page, { backup: backup.folder });
  try {
    const terminal = world.section.getByTestId('restore-terminal');
    await expect(terminal.getByText('backbone restore')).toBeHidden();
    await terminal.getByText('From a terminal').click();
    await expect(terminal).toContainText('--dry-run');
    await expect(terminal).toContainText('backbone restore <backup-folder> --home <new-data-folder>');
  } finally { await world.end(); await backup.end(); }
});

test('from the first button to the finished restore with the keyboard alone', async ({ page }) => {
  const backup = await makeBackup(['Harbor']);
  const world = await openBackup(page, { backup: backup.folder });
  let target = '';
  try {
    // Reach the section's button by Tab from the Backup entry in Settings.
    // The section shows the button once it has read whether restore is available; a person tabs to what they can see.
    await expect(world.settings.getByRole('button', { name: 'Restore from a backup…' })).toBeVisible();
    await world.settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Backup' }).focus();
    await tabTo(page, 'Restore from a backup…');
    await page.keyboard.press('Enter');
    const dialog = dialogOf(page);
    await expect(dialog).toContainText('Step 1 of 4: Backup');
    await tabTo(page, 'Choose backup folder…');
    await page.keyboard.press('Enter');
    await expect(dialog).toContainText('Step 2 of 4: Preview');
    await tabTo(page, 'Choose where it goes');
    await page.keyboard.press('Space');
    await expect(dialog.getByTestId('restore-place')).toContainText('-restored-');
    target = (await dialog.getByTestId('restore-place').textContent())!;
    await tabTo(page, 'Restore');
    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('restore-done')).toBeVisible();
    // The finish state has the focus on its one action.
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    expect((await readRestored(target)).projects).toContain('Harbor');
  } finally { await world.end(); if (target) await removeDataHome(target); await backup.end(); }
});
