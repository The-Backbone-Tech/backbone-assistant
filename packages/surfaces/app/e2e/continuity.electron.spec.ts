import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// Existing app/host, controlled harness and synthetic data. No provider inference or account.
import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { withHomeLock } from '@backbone-next/platform/composition/home-lock';
import { api, appDir, phase2ProjectAndAttach } from './journey';

const executablePath = createRequire(import.meta.url)('electron') as string;
const personHomes = new Map<string, string>();
// Prepared development homes contain plaintext vaults, which the installed app correctly refuses.
const testHome = (label: string) => process.env.BACKBONE_APP_EXECUTABLE
  ? mkdtempSync(join(tmpdir(), `backbone-${label}-`)) : freshDataHome(label);

async function quit(app: ElectronApplication) {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  await closed;
}

async function cleanup(app: ElectronApplication | undefined, home: string) {
  // Teardown owns only the process this test launched. A failed close guard must not strand it
  // and its synthetic database. This forced cleanup is not evidence of crash recovery.
  if (app) {
    const child = app.process();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  }
  await removeDataHome(home);
  const person = personHomes.get(home);
  if (person) rmSync(person, { recursive: true, force: true });
  personHomes.delete(home);
}

async function launch(home: string, saveDelayMs = 0) {
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  const person = personHomes.get(home) ?? mkdtempSync(join(tmpdir(), 'continuity-person-'));
  personHomes.set(home, person);
  const app = await _electron.launch({ executablePath: installed || executablePath, args: installed ? [] : [appDir], env: { ...process.env,
    BACKBONE_HOME: home, BACKBONE_USER_HOME: person, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-stub',
    BACKBONE_MODEL_ENDPOINT: '', BACKBONE_STUB_WRITE_DELAY_MS: '5000',
    BACKBONE_STUB_SAVE_DELAY_MS: String(saveDelayMs),
  } });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
  const page = await app.firstWindow();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
  return { app, page };
}

async function setup(page: Page) {
  const project = await api<{ ok: boolean; value: { id: string } }>(page, 'projects.create', { name: 'Continuing work', kind: 'folder' });
  const source = await api<{ ok: boolean; value: { id: string } }>(page, 'material.attach', { projectId: project.value.id, name: 'source.md', mediaType: 'text/markdown', base64: Buffer.from('# Source\nPreserve this original.').toString('base64') });
  const sent = await api<{ ok: boolean; value: { threadId: string } }>(page, 'turns.send', { projectId: project.value.id,
    text: 'Write an editable brief from these', attachments: [source.value.id],
    settings: { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: crypto.randomUUID(),
  });
  await expect.poll(async () => (await api<{ ok: boolean; value: { summary: { running: boolean } } }>(page, 'threads.get', { id: sent.value.threadId })).value.summary.running).toBe(false);
  const entries = await api<{ id: string; name: string }[]>(page, 'material.list', { projectId: project.value.id });
  const brief = entries.find((entry) => entry.name === 'brief.md')!;
  const prefs = await api<Record<string, unknown>>(page, 'viewer.get', {});
  await api(page, 'viewer.put', { prefs: { ...prefs, selectedThreadId: sent.value.threadId, selectedProjectId: project.value.id,
    pane: { open: true, tabs: [{ id: `file:${brief.id}`, kind: 'file', materialId: brief.id }], active: `file:${brief.id}` },
  } });
  await page.reload();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edit brief.md' })).toBeVisible();
  return { brief, source: source.value, threadId: sent.value.threadId };
}

test('ordinary quit drains unsaved edits and the next message; reopen, Save, Stop and continue preserve work', async () => {
  const home = testHome('continuing-native');
  let app: ElectronApplication | undefined;
  try {
    let current = await launch(home); app = current.app;
    let page = current.page;
    const { brief, source, threadId } = await setup(page);
    const words = '# Human wording before quit';
    const message = 'Keep this next message across reopening';
    // Neither debounce is acknowledged before Quit. The actual main/preload handoff must drain.
    await page.getByRole('textbox', { name: 'Edit brief.md' }).fill(words);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(message);
    await quit(app); app = undefined;
    current = await launch(home); app = current.app; page = current.page;
    await expect(page.getByRole('textbox', { name: 'Edit brief.md' })).toContainText(words);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(message);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id })).value).toMatchObject({ text: words, entry: { current: 2 } });

    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Draft a brief for this work');
    const turnsBefore = (await api<{ value: { turns: unknown[] } }>(page, 'threads.get', { id: threadId })).value.turns.length;
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // Wait for this turn's own write to cross, not merely a spinner, and not the earlier turn's:
    // Stop must preserve its uncertain result.
    const latest = async () => (await api<{ value: { turns: { effects: { key: string }[] }[] } }>(page, 'threads.get', { id: threadId })).value.turns;
    await expect.poll(async () => { const turns = await latest(); return turns.length > turnsBefore && turns.at(-1)!.effects.some((e) => e.key); }).toBe(true);
    await page.getByRole('button', { name: 'Stop', exact: true }).click({ timeout: TEST_HANG_MS }).catch(async (error: unknown) => {
      throw new Error(`Stop could not be pressed during the write. Last turn: ${JSON.stringify((await latest()).at(-1)).slice(0, 1200)}. ${String(error).slice(0, 200)}`);
    });
    await expect(page.getByTestId('effect-UNKNOWN').last()).toContainText('will not be resent');
    await quit(app); app = undefined;
    current = await launch(home); app = current.app; page = current.page;
    await expect(page.getByTestId('effect-UNKNOWN').last()).toBeVisible();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Summarize the current context');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await api<{ ok: boolean; value: { summary: { running: boolean }; turns: { status: string }[] } }>(page, 'threads.get', { id: threadId })).value).toMatchObject({ summary: { running: false }, turns: [expect.anything(), expect.anything(), expect.objectContaining({ status: 'done' })] });
    const saved = await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id });
    expect(saved.value.text).toBe(words);
    expect(saved.value.entry.current).toBe(2);
    const original = await api<{ ok: boolean; value: { text: string } }>(page, 'material.read', { id: source.id });
    expect(original.value.text).toBe('# Source\nPreserve this original.');
  } finally {
    await cleanup(app, home);
  }
});

test('a failed close flush leaves the window and editor open, then a retry can close', async () => {
  const home = testHome('failed-close-native');
  let app: ElectronApplication | undefined;
  let releaseFailure: (() => Promise<void>) | undefined;
  try {
    const current = await launch(home); app = current.app;
    const page = current.page;
    await setup(page);
    const removeFailure = await page.evaluateHandle(() => window.backbone!.beforeClose!(
      async () => { throw new Error('Controlled persistence failure'); }, () => {},
    ));
    releaseFailure = async () => { await removeFailure.evaluate((remove) => remove()); await removeFailure.dispose(); };
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect(page.getByRole('alert')).toContainText('This window stayed open');
    await expect(page.getByRole('textbox', { name: 'Edit brief.md' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Edit brief.md' }).fill('# Kept open after the failed close');
    await releaseFailure(); releaseFailure = undefined;
    await quit(app); app = undefined;
  } finally {
    await releaseFailure?.().catch(() => {});
    await cleanup(app, home);
  }
});

test('ordinary quit joins an in-flight Save before draining the newer edit', async () => {
  const home = testHome('quit-during-save');
  let app: ElectronApplication | undefined;
  try {
    let current = await launch(home, 2_000); app = current.app;
    let page = current.page;
    const { brief } = await setup(page);
    await page.getByTestId('turn').first().getByRole('button', { name: /^brief\.md\s*v1$/ }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const first = '# Save this snapshot before quitting';
    const next = '# Keep the newer edit after that saved snapshot';
    await page.getByRole('textbox', { name: 'Edit brief.md' }).fill(first);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => existsSync(join(home, 'material', brief.id, 'intent.json'))).toBe(true);
    await page.getByRole('textbox', { name: 'Edit brief.md' }).fill(next);
    await quit(app); app = undefined;
    current = await launch(home); app = current.app; page = current.page;
    const saved = await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id });
    expect(saved.value).toMatchObject({ text: first, entry: { current: 2 } });
    await expect(page.getByRole('textbox', { name: 'Edit brief.md' })).toContainText(next);
    const draft = await api<{ text: string; meta: { baseVersion: number } }>(page, 'drafts.get', { key: `edit:${brief.id}` });
    expect(draft).toMatchObject({ text: next, meta: { baseVersion: 2 } });
    await quit(app); app = undefined;
  } finally {
    await cleanup(app, home);
  }
});

test('quit during a pending first send drains its draft transfer and navigation before reopening', async () => {
  const home = testHome('quit-during-home-send');
  let app: ElectronApplication | undefined;
  let release!: () => void;
  let locked: Promise<void> | undefined;
  try {
    let current = await launch(home); app = current.app;
    let page = current.page;
    await phase2ProjectAndAttach(page);
    let entered!: () => void;
    const begun = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    locked = withHomeLock(home, async () => { entered(); await held; });
    await begun;
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Summarize the sources');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const next = 'This later question must reopen in the new chat';
    await composer.fill(next);
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await expect.poll(() => page.evaluate(() => document.documentElement.inert)).toBe(true);
    expect(app.process().exitCode).toBeNull();
    release();
    await locked; locked = undefined;
    await closed; app = undefined;
    current = await launch(home); app = current.app; page = current.page;
    await expect(page.getByRole('list', { name: 'Transcript' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(next);
    const threads = await api<{ id: string }[]>(page, 'threads.list', {});
    const prefs = await api<{ selectedThreadId: string }>(page, 'viewer.get', {});
    expect(prefs.selectedThreadId).toBe(threads[0].id);
    expect(await api<{ text: string }>(page, 'drafts.get', { key: `composer:${threads[0].id}` })).toMatchObject({ text: next });
    await quit(app); app = undefined;
  } finally {
    release?.();
    await locked;
    await cleanup(app, home);
  }
});
