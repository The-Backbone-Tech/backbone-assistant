// Prove the worker boundary at the desktop file origin, with the real sandbox and CSP.
import { expect, test, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { api, appDir } from './journey';
import { pdfFixture, wordFixture, workbookFixture, sharedStringWorkbookFixture } from './preview-fixtures';

const executablePath = createRequire(import.meta.url)('electron') as string;
test('preview workers render at the desktop file origin without widening the sandbox', async () => {
  const folder = freshDataHome('desktop-previews');
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath, args: [appDir], env: { ...process.env, BACKBONE_HOME: folder, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub', BACKBONE_MODEL_ENDPOINT: '', BACKBONE_WINDOW_WIDTH: '1440', BACKBONE_WINDOW_HEIGHT: '900' } });
    const page = await app.firstWindow();
    const errors: string[] = [], requests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.context().on('request', request => { if (request.url().includes('preview-attack.invalid')) requests.push(request.url()); });
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    expect(page.url()).toMatch(/^file:/);
    const window = await app.browserWindow(page);
    const preferences = await window.evaluate(window => window.webContents.getLastWebPreferences());
    expect(preferences.sandbox).toBe(true);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.nodeIntegration).toBe(false);
    // The preference API omits this field when the documented disabled default is used.
    expect(preferences.plugins ?? false).toBe(false);
    const project = await api<{ ok: boolean; value: { id: string } }>(page, 'projects.create', { name: 'Desktop document review', kind: 'folder' });
    expect(project.ok).toBe(true);
    for (const [name, bytes, expected] of [['desktop.pdf', pdfFixture(), 'Harbor PDF review'], ['desktop.docx', wordFixture(), 'Quarterly review'], ['desktop.xlsx', workbookFixture(), 'North']] as const) {
      const attached = await api<{ ok: boolean; value: { id: string } }>(page, 'material.attach', { projectId: project.value.id, name, base64: bytes.toString('base64'), mediaType: 'application/octet-stream' });
      expect(attached.ok).toBe(true);
      const prefs = await api<Record<string, unknown>>(page, 'viewer.get', {});
      const tab = { id: `file:${attached.value.id}`, kind: 'file', materialId: attached.value.id };
      await api(page, 'viewer.put', { prefs: { ...prefs, selectedProjectId: project.value.id, pane: { open: true, tabs: [tab], active: tab.id } } });
      await page.reload();
      const file = page.getByTestId('file-tab').filter({ visible: true });
      await expect(file).toContainText(expected);
      await expect(file.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    }
    const hostile = await api<{ ok: boolean; value: { id: string } }>(page, 'material.attach', { projectId: project.value.id, name: 'shared-hostile.xlsx', base64: sharedStringWorkbookFixture().toString('base64'), mediaType: 'application/octet-stream' });
    expect(hostile.ok).toBe(true);
    const prefs = await api<Record<string, unknown>>(page, 'viewer.get', {});
    const tab = { id: `file:${hostile.value.id}`, kind: 'file', materialId: hostile.value.id };
    await api(page, 'viewer.put', { prefs: { ...prefs, selectedProjectId: project.value.id, pane: { open: true, tabs: [tab], active: tab.id } } });
    await page.reload();
    await expect(page.getByTestId('file-tab').filter({ visible: true })).toContainText('Showing the first 1 row of 100');
    expect(await page.getByTestId('file-tab').filter({ visible: true }).getByRole('cell').count()).toBeLessThanOrEqual(1000);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    // A complete app restart, with the partial workbook still the selected saved tab.
    await app.close();
    app = await _electron.launch({ executablePath, args: [appDir], env: { ...process.env, BACKBONE_HOME: folder, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub', BACKBONE_MODEL_ENDPOINT: '', BACKBONE_WINDOW_WIDTH: '1440', BACKBONE_WINDOW_HEIGHT: '900' } });
    const restored = await app.firstWindow();
    await expect(restored.getByTestId('file-tab').filter({ visible: true })).toContainText('Showing the first 1 row of 100');
    await expect(restored.getByRole('button', { name: 'Close shared-hostile.xlsx', exact: true })).toBeEnabled();
    await restored.getByRole('button', { name: 'Close shared-hostile.xlsx', exact: true }).click();
    await expect(restored.getByRole('tab', { name: 'shared-hostile.xlsx', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
  } finally { await app?.close(); await removeDataHome(folder); }
});
