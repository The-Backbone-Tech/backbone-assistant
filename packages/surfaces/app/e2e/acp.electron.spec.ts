// The same journey runs unpacked and through the owned DMG installation fixture.
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { api, appDir } from './journey';

test('own-agent-route: installed ACP setup survives restart and writes a document with a versioned receipt', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'acp-desktop-home-')));
  const person = realpathSync(mkdtempSync(join(tmpdir(), 'acp-desktop-person-')));
  let app: ElectronApplication | undefined;
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  const launch = async (harness?: string) => {
    const supplied = { ...process.env, BACKBONE_HOME: home, BACKBONE_USER_HOME: person,
      BACKBONE_HARNESS: harness, BACKBONE_MODEL_ENDPOINT: undefined, BACKBONE_CODEX_MODEL: undefined,
      ACP_FAKE_MODE: 'mcp-write', BACKBONE_KEYS: 'plaintext' };
    const env = Object.fromEntries(Object.entries(supplied).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    app = await electron.launch(installed ? { executablePath: installed, args: [], env } : { args: [appDir], env });
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 });
    return page;
  };
  try {
    let page = await launch('harness-stub');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'AI and models', exact: true }).click();
    const form = dialog.getByRole('form', { name: 'ACP agent', exact: true });
    await form.getByLabel('Agent setup').selectOption('custom');
    await form.getByLabel('Agent name', { exact: true }).fill('installed-owned-agent');
    await form.getByLabel('Executable', { exact: true }).fill(process.execPath);
    await form.getByLabel('Arguments', { exact: true }).fill(JSON.stringify([new URL('../../../modules/harness-acp/test/fake-agent.mjs', import.meta.url).pathname]));
    await form.getByLabel('Environment variable names', { exact: true }).fill('ACP_FAKE_MODE');
    if (process.platform !== 'darwin') await form.getByLabel('Agent rights').selectOption('person-rights');
    await form.getByRole('button', { name: 'Resolve executable', exact: true }).click();
    await expect(form.getByLabel('Resolved executable', { exact: true })).toContainText(/^\//);
    for (const checkbox of await form.getByRole('checkbox').all()) await checkbox.check();
    await form.getByRole('button', { name: 'Save ACP agent' }).click();
    await expect(form.getByRole('status', { name: 'Agent save result', exact: true })).toBeVisible();
    await app!.close(); app = undefined;
    page = await launch();
    expect(await api(page, 'settings.model.get', {})).toMatchObject({ active: { kind: 'agent' } });
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Installed ACP work');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Write a brief');
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await expect.poll(async () => {
      const threads = await api<{ id: string }[]>(page, 'threads.list', {});
      if (!threads.length) return false;
      const thread = await api<{ value: { turns: { status: string; effects: { outcome: string; version?: number; sha256?: string }[] }[] } }>(page, 'threads.get', { id: threads[0].id });
      const turn = thread.value.turns[0];
      return turn?.status === 'done' && turn.effects.some(effect => effect.outcome === 'DONE' && effect.version && effect.sha256);
    }).toBeTruthy();
    await page.keyboard.press('ControlOrMeta+p');
    const file = page.getByTestId('file-row').filter({ hasText: 'brief.md' });
    await expect(file).toBeVisible();
    await file.click();
    await expect(page.getByTestId('reader').filter({ visible: true })).toContainText('ACP brief');
    await page.screenshot({ path: test.info().outputPath('acp-receipt.png') });
  } finally {
    await app?.close();
    await removeDataHome(home);
    rmSync(person, { recursive: true, force: true });
  }
});
