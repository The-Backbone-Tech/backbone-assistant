// One bounded native-chrome journey. Synthetic files and the controlled harness; no model route.
import { expect, test, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { api, appDir, expectDocumentInfo, repoRoot } from './journey';

const executablePath = createRequire(import.meta.url)('electron') as string;
test('compact native bar preserves edit, Save, resize clearance and cold reopen', async () => {
  const home = freshDataHome('compact-header');
  const evidence = join(repoRoot, 'evidence', 'app-reference-20261027', 'header-implementation', 'electron', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(evidence, { recursive: true });
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await _electron.launch({ executablePath, args: [appDir], env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-stub', BACKBONE_MODEL_ENDPOINT: '', BACKBONE_WINDOW_WIDTH: '1440', BACKBONE_WINDOW_HEIGHT: '900' } });
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    return page;
  };
  try {
    let page = await launch();
    const project = await api<{ ok: boolean; value: { id: string } }>(page, 'projects.create', { name: 'Harbor', kind: 'folder' });
    expect(project.ok).toBe(true);
    const attached = await api<{ ok: boolean; value: { id: string } }>(page, 'material.attach', { projectId: project.value.id, name: 'launch-notes.md', mediaType: 'text/markdown', base64: Buffer.from('# Harbor pilot\n\nLaunch: 19 November. Budget remaining: EUR 5,100.').toString('base64') });
    expect(attached.ok).toBe(true);
    const sent = await api<{ ok: boolean; value: { threadId: string } }>(page, 'turns.send', { projectId: project.value.id, text: 'Write an editable brief from these', attachments: [attached.value.id], settings: { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: crypto.randomUUID() });
    expect(sent.ok).toBe(true);
    await expect.poll(async () => (await api<{ ok: boolean; value: { summary: { running: boolean } } }>(page, 'threads.get', { id: sent.value.threadId })).value.summary.running).toBe(false);
    const material = await api<{ id: string; name: string }[]>(page, 'material.list', { projectId: project.value.id });
    const brief = material.find(file => file.name === 'brief.md')!;
    expect(brief).toBeTruthy();
    await api(page, 'threads.update', { id: sent.value.threadId, patch: { title: 'Pilot launch brief' } });
    const prefs = await api<Record<string, unknown>>(page, 'viewer.get', {});
    await api(page, 'viewer.put', { prefs: { ...prefs, theme: 'light', selectedThreadId: sent.value.threadId, selectedProjectId: project.value.id, pane: { open: true, tabs: [{ id: `file:${brief.id}`, kind: 'file', materialId: brief.id }], active: `file:${brief.id}` } } });
    await page.reload();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Edit brief.md' });
    await expect(editor).toBeVisible();
    const chat = await page.getByTestId('conversation-bar').boundingBox();
    const workspace = await page.getByTestId('workspace-bar').boundingBox();
    expect(Math.abs(chat!.y - workspace!.y)).toBeLessThan(2);
    expect(workspace!.height).toBeLessThanOrEqual(48);
    if (process.platform === 'darwin') {
      await expect(page.locator('[data-native-titlebar=true]')).toBeVisible();
      const window = await app!.browserWindow(page);
      const bounds = await window.evaluate(window => ({ outer: window.getBounds(), content: window.getContentBounds() }));
      expect(bounds.outer.height - bounds.content.height, 'native controls share the content row').toBeLessThanOrEqual(4);
      await page.getByRole('button', { name: 'Hide side pane', exact: true }).click();
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await window.evaluate(window => window.setSize(640, 800));
      await expect(page.getByRole('button', { name: 'Open sidebar', exact: true })).toBeVisible();
      expect((await page.getByRole('button', { name: 'Open sidebar', exact: true }).boundingBox())!.x, 'mobile control clears native traffic lights after collapse').toBeGreaterThanOrEqual(76);
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
      await window.evaluate(window => window.setSize(1440, 900));
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Show side pane', exact: true }).click();
    }
    const words = '# Harbor launch brief\n\nReviewed by the workspace user. Preserve this wording across restart.\n';
    await editor.fill(words);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectDocumentInfo(page, 'v2 · saved by you');
    const current = await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id });
    expect(current.value.text).toBe(words);
    expect(current.value.entry.current).toBe(2);
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    const full = await page.getByTestId('file-tab').boundingBox();
    expect(full!.width).toBe(await page.evaluate(() => innerWidth));
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await page.getByTestId('file-tab').boundingBox())!.x).toBeGreaterThan(0);
    await page.screenshot({ path: join(evidence, 'compact-light.png') });
    await app!.close(); app = undefined;
    page = await launch();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const reopenedEditor = page.getByRole('textbox', { name: 'Edit brief.md' });
    await expect(reopenedEditor).toBeVisible();
    // CodeMirror renders block lines; textContent concatenates them without newlines.
    await expect(reopenedEditor.locator('.cm-line')).toHaveText(words.split('\n'));
    const reopened = await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id });
    expect(reopened.ok).toBe(true);
    expect(reopened.value.text).toBe(words);
    expect(reopened.value.entry.current).toBe(2);
    await expectDocumentInfo(page, 'v2 · saved by you');
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
    await page.screenshot({ path: join(evidence, 'compact-dark-reopened.png') });
    const source = await api<{ ok: boolean; value: { text: string } }>(page, 'material.read', { id: attached.value.id });
    expect(source.value.text).toBe('# Harbor pilot\n\nLaunch: 19 November. Budget remaining: EUR 5,100.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  } finally {
    await app?.close();
    await removeDataHome(home);
  }
});
