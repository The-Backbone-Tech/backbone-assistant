// Real IPC -> native confirmation -> person-only Host path, with the test presence path used by
// tools.electron.spec.ts. No Keychain or real Touch ID prompt is used.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectorWorld } from './connector-world';
import { api, appDir } from './journey';

interface Asked { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }
async function answer(app: ElectronApplication, answers: number[]) {
  await app.evaluate(({ dialog, systemPreferences }, queue) => {
    const g = globalThis as unknown as { asked: Asked[]; answers: number[] };
    g.asked = []; g.answers = queue;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as Asked;
      g.asked.push(options);
      return { response: g.answers.shift() ?? 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    systemPreferences.canPromptTouchID = () => false;
    systemPreferences.promptTouchID = async () => { throw new Error('No real presence prompt in this test.'); };
  }, answers);
}
const asked = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { asked: Asked[] }).asked);

async function holdDialog(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { answerPending?: (response: number) => void };
    g.answerPending = undefined;
    dialog.showMessageBox = (async () => new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => {
      g.answerPending = (response) => resolve({ response, checkboxChecked: false });
    })) as typeof dialog.showMessageBox;
  });
}
const pendingDialog = (app: ElectronApplication) => expect.poll(() => app.evaluate(() => typeof (globalThis as unknown as { answerPending?: unknown }).answerPending)).toBe('function');
const finishDialog = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { answerPending(response: number): void }).answerPending(0));

test('server and tool switches require main’s native confirmation, cancel grants nothing, and other pages cannot ask', async () => {
  const home = freshDataHome('connectors-electron');
  const world = connectorWorld();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [appDir], env: { ...process.env, ...world.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext' } as Record<string, string> });
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Connected tools', exact: true }).click();
    const row = settings.getByTestId('connector-claude-code:notes');
    await row.getByRole('button', { name: 'List tools', exact: true }).click();
    await expect(row.getByLabel('What search does')).toBeVisible();
    for (const tool of [undefined, 'search']) {
      const r = await api<{ ok: boolean; detail: string }>(page, 'connectors.set', { serverId: 'claude-code:notes', ...(tool ? { tool: { name: tool, enabled: true } } : { enabled: true }) });
      expect(r).toMatchObject({ ok: false, detail: 'Turning a connector on is done by the person in the desktop app.' });
    }
    await answer(app, []);
    await row.getByRole('button', { name: 'Turn on notes', exact: true }).click();
    await expect.poll(async () => (await asked(app!)).length).toBe(1);
    await expect(row.getByRole('button', { name: 'Turn on notes', exact: true })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Allow sending', exact: true })).toHaveCount(0);
    // A hidden launch value changed while the question was open: its old click grants nothing.
    const original = readFileSync(world.files.claude, 'utf8');
    const config = JSON.parse(original);
    await holdDialog(app);
    await row.getByRole('button', { name: 'Turn on notes', exact: true }).click();
    await pendingDialog(app);
    config.mcpServers.notes.env.NOTES_VALUE = 'second-account';
    writeFileSync(world.files.claude, JSON.stringify(config));
    await finishDialog(app);
    await expect(row).toContainText('The connector changed while you were asked; nothing was turned on. Look again.');
    await expect(row.getByRole('button', { name: 'Turn on notes', exact: true })).toBeEnabled();
    writeFileSync(world.files.claude, original);
    await answer(app, [0]);
    await row.getByRole('button', { name: 'Turn on notes', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Turn off notes', exact: true })).toBeVisible();
    expect((await asked(app))[0]).toMatchObject({ message: 'Turn on this server for every engine?', buttons: ['Turn on', 'Cancel'], defaultId: 1, cancelId: 1 });

    await answer(app, []);
    await row.getByRole('button', { name: 'Turn on search', exact: true }).click();
    await expect.poll(async () => (await asked(app!)).length).toBe(1);
    await expect(row.getByRole('button', { name: 'Turn on search', exact: true })).toBeEnabled();
    // A different tool definition is listed while its question waits: the old click cannot enable it.
    await holdDialog(app);
    await row.getByRole('button', { name: 'Turn on search', exact: true }).click();
    await pendingDialog(app);
    config.mcpServers.notes.env.FAKE_MCP_VARIANT = 'swapped';
    writeFileSync(world.files.claude, JSON.stringify(config));
    await api(page, 'connectors.refresh', { serverId: 'claude-code:notes' });
    await finishDialog(app);
    const searchRow = row.getByLabel('What search does').locator('..').locator('..');
    await expect(searchRow).toContainText('The connector changed while you were asked; nothing was turned on. Look again.');
    await expect(row.getByRole('button', { name: 'Turn on search', exact: true })).toBeEnabled();
    writeFileSync(world.files.claude, original);
    await api(page, 'connectors.refresh', { serverId: 'claude-code:notes' });
    await answer(app, [0]);
    await row.getByRole('button', { name: 'Turn on search', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Turn off search', exact: true })).toBeVisible();
    const read = (await asked(app))[0];
    expect(read.message).toBe('Turn on this tool for every engine?');
    expect(read.detail).toContain('Server: notes');
    expect(read.detail).toContain('Tool: search');
    expect(read.detail.startsWith('This tool will run as a read without asking each time.')).toBe(true);
    expect(read.detail).toContain('Search the notes.');
    expect(read.detail).toContain('The server says it only reads.');
    expect(read.detail).toContain('without asking each time');

    await answer(app, [0]);
    await row.getByRole('button', { name: 'Turn on plain', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Turn off plain', exact: true })).toBeVisible();
    expect((await asked(app))[0].detail).toContain('The server does not say what it does, so it counts as a change.');
    await answer(app, [0]);
    await row.getByRole('button', { name: 'Turn on draft_note', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Turn off draft_note', exact: true })).toBeVisible();
    expect((await asked(app))[0].detail).toContain('The server says it can change things.');

    // Resetting an effect override back to a server-annotated read needs the person's word too.
    await row.getByLabel('What search does').selectOption('effect');
    await answer(app, []);
    await row.getByLabel('What search does').selectOption('auto');
    await expect.poll(async () => (await asked(app!)).length).toBe(1);
    await expect(row.getByLabel('What search does')).toHaveValue('effect');
    await answer(app, [0]);
    await row.getByLabel('What search does').selectOption('auto');
    await expect(row.getByLabel('What search does')).toHaveValue('auto');

    // Turning off takes authority away and shows no dialog.
    await answer(app, []);
    await row.getByRole('button', { name: 'Turn off search', exact: true }).click();
    await row.getByRole('button', { name: 'Turn off notes', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Turn on notes', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Turn on search', exact: true })).toBeVisible();
    expect(await asked(app)).toEqual([]);

    const foreign = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
      try {
        await other.loadURL('data:text/html,foreign');
        return await other.webContents.executeJavaScript("Promise.all([window.backbone.enableConnector('claude-code:notes'), window.backbone.enableConnectorTools('claude-code:notes')].map(p => p.then(() => 'granted', e => e.message)))");
      } finally { other.destroy(); }
    }, join(appDir, 'dist/electron/preload.cjs'));
    expect(foreign).toHaveLength(2);
    for (const result of foreign) expect(result).toContain('only this app\'s own page');
    expect(await asked(app)).toEqual([]);
  } finally { await app?.close(); await removeDataHome(home); world.remove(); }
});


test('one native question enables a capped server tool set, cancellation and changed definitions grant nothing', async () => {
  const home = freshDataHome('connector-tools-electron');
  const world = connectorWorld();
  const definitionsFile = join(world.root, 'definitions.json');
  const hostile = 'Draft a note.\n\u202e' + 'x'.repeat(10_000);
  writeFileSync(definitionsFile, JSON.stringify({ draft_note: hostile }));
  const config = JSON.parse(readFileSync(world.files.claude, 'utf8'));
  config.mcpServers.notes.env.FAKE_MCP_DEFINITIONS_FILE = definitionsFile;
  writeFileSync(world.files.claude, JSON.stringify(config));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [appDir], env: { ...process.env, ...world.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext' } as Record<string, string> });
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Connected tools', exact: true }).click();
    const row = settings.getByTestId('connector-claude-code:notes');
    await row.getByRole('button', { name: 'List tools', exact: true }).click();
    await answer(app, [0]);
    await row.getByRole('button', { name: 'Turn on notes', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Turn off notes', exact: true })).toBeVisible();
    const state = async () => (await api<{ servers: { enabled: boolean; egress: boolean; tools: { name: string; enabled: boolean; standing?: unknown }[] }[] }>(page, 'connectors.list', {})).servers[0];
    await answer(app, []);
    await row.getByRole('button', { name: 'Turn on its tools', exact: true }).click();
    await expect.poll(async () => (await asked(app!)).length).toBe(1);
    const cancelled = (await asked(app))[0];
    expect(cancelled.message).toBe('Turn on these 8 tools?');
    expect(cancelled.detail.startsWith('Read tools will run without asking; tools that change things stay held unless separately permitted.')).toBe(true);
    expect(cancelled.detail).toContain('4 more tools stay off');
    expect(cancelled.detail).toContain('Tool: draft_note');
    expect(cancelled.detail).toContain('The server says it can change things.');
    expect(cancelled.detail).toContain('The server says it only reads.');
    expect(cancelled.detail).toContain('…');
    expect(cancelled.detail).not.toMatch(/\u202e|Draft a note\.\n/);
    expect(cancelled.detail.length).toBeLessThan(5_000);
    expect((await state()).tools.every((t) => !t.enabled)).toBe(true);

    await holdDialog(app);
    await row.getByRole('button', { name: 'Turn on its tools', exact: true }).click();
    await pendingDialog(app);
    // Change text beyond the clipped preview under the exact same server launch.
    writeFileSync(definitionsFile, JSON.stringify({ draft_note: hostile + 'changed' }));
    await api(page, 'connectors.refresh', { serverId: 'claude-code:notes' });
    await finishDialog(app);
    await expect(row).toContainText('The connector changed while you were asked; nothing was turned on. Look again.');
    expect((await state()).enabled).toBe(true);
    expect((await state()).tools.every((t) => !t.enabled)).toBe(true);

    await answer(app, [0]);
    await row.getByRole('button', { name: 'Turn on its tools', exact: true }).click();
    await expect.poll(async () => (await state()).tools.filter((t) => t.enabled).length).toBe(8);
    expect((await asked(app)).map((q) => q.message)).toEqual(['Turn on these 8 tools?']);
    expect((await state()).egress).toBe(false);
    expect((await state()).tools.every((t) => !t.standing)).toBe(true);
    await answer(app, [0]);
    await row.getByRole('button', { name: 'Turn on its tools', exact: true }).click();
    await expect.poll(async () => (await state()).tools.filter((t) => t.enabled).length).toBe(12);
    expect((await asked(app)).map((q) => q.message)).toEqual(['Turn on these 4 tools?']);
    await expect(row.getByRole('button', { name: 'Turn on its tools', exact: true })).toHaveCount(0);
  } finally { await app?.close(); await removeDataHome(home); world.remove(); }
});
