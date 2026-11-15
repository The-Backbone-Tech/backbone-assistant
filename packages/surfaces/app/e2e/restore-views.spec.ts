// Settings › Backup › Restore from a backup, every step as the person sees it, in Light and Dark at 1440 px and
// in a narrow window. A real backup is restored on the browser bridge; the screenshots go to the folder named
// by BACKBONE_RESTORE_SHOTS (default: the ignored evidence/ folder), under the project's name.
import { removeDataHome } from '@backbone-next/platform/composition';
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { breakable, makeBackup, openBackup } from './restore-world';
import { repoRoot } from './journey';

test('every step of restoring a backup', async ({ page }, info) => {
  const dir = join(process.env.BACKBONE_RESTORE_SHOTS ?? join(repoRoot, 'evidence', 'restore'), info.project.name.replace(/^restore-views-/, ''));
  mkdirSync(dir, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: join(dir, `${name}.png`) });
  const backup = await makeBackup(['Harbor', 'Ledger']);
  const broken = breakable(backup.folder, backup.scratch);
  const targets: string[] = [];
  const world = await openBackup(page, { backup: backup.folder });
  try {
    await shot('01-backup-section');
    await world.section.getByTestId('restore-terminal').getByText('From a terminal').click();
    await shot('02-from-a-terminal');
    await world.section.getByTestId('restore-terminal').getByText('From a terminal').click();

    await world.section.getByRole('button', { name: 'Restore from a backup…' }).click();
    const dialog = page.getByTestId('restore-dialog');
    await shot('03-choose-backup');
    await dialog.getByRole('button', { name: 'Choose backup folder…' }).click();
    await expect(dialog).toContainText('Step 2 of 4: Preview');
    await shot('04-preview');
    await dialog.getByText('What comes in and what does not').click();
    await shot('05-preview-detail');
    await dialog.getByRole('button', { name: 'Choose where it goes' }).click();
    await expect(dialog.getByTestId('restore-place')).toContainText('-restored-');
    targets.push((await dialog.getByTestId('restore-place').textContent())!);
    await shot('06-place');
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(dialog.getByRole('status', { name: 'Restoring' })).toBeVisible();
    await shot('07-restoring');
    await expect(dialog.getByTestId('restore-done')).toBeVisible();
    await shot('08-finished');
    await dialog.getByText('How to open it').click();
    await shot('09-finished-how-to-open');
    await dialog.getByRole('button', { name: 'Done' }).click();
  } finally { await world.end(); for (const t of targets) await removeDataHome(t); }

  const failing = await openBackup(page, { backup: broken });
  try {
    await failing.section.getByRole('button', { name: 'Restore from a backup…' }).click();
    const dialog = page.getByTestId('restore-dialog');
    await dialog.getByRole('button', { name: 'Choose backup folder…' }).click();
    await dialog.getByRole('button', { name: 'Choose where it goes' }).click();
    await expect(dialog.getByTestId('restore-place')).toContainText('-restored-');
    targets.push((await dialog.getByTestId('restore-place').textContent())!);
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(dialog.getByTestId('restore-refused')).toBeVisible();
    await shot('10-stopped-part-way');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await shot('11-section-after-part-way');
  } finally { await failing.end(); for (const t of targets) await removeDataHome(t); await backup.end(); }

  const off = await openBackup(page, { backup: '/nowhere', env: { BACKBONE_BRIDGE_RESTORE_UNAVAILABLE: 'This app is set up by your company, which keeps data folders under its own control.' } });
  try { await shot('12-unavailable'); } finally { await off.end(); }
});
