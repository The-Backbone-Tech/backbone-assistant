import type { MaterialEntry, Receipt, Thread, TurnSettings } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { assertHomeWriteAdmission } from '@backbone-next/platform/composition/home-lock';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, appDir } from './journey';
import { rewindStep } from './fixtures/rewind-model';

test('a person rewinds conversation and agent files, keeps their own edit and inspects receipts after restart', async ({}, testInfo) => {
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  const home = installed ? mkdtempSync(join(tmpdir(), 'rewind-installed-')) : freshDataHome('rewind-electron');
  const userHome = join(home, 'test-person');
  mkdirSync(userHome, { recursive: true });
  const model = await startScriptedModel('rewind-script', rewindStep);
  let app: ElectronApplication | undefined;
  let threadId: string | undefined;
  const rendererErrors: string[] = [];
  const launch = async () => {
    const env = { ...process.env, BACKBONE_HOME: home, BACKBONE_USER_HOME: userHome, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model } as Record<string, string>;
    app = await electron.launch(installed ? { executablePath: installed, args: [], env } : { args: [appDir], env });
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    page.on('pageerror', error => { rendererErrors.push(error.message); console.log('rewind renderer error:', error.message); });
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 });
    // Final turn events may arrive while quit drains. Keep that race reproducible:
    // the renderer must leave after its flush, before the Host refuses refreshes.
    await app.evaluate(({ app, BrowserWindow }) => {
      // Keep a fast local shutdown from hiding refreshes after Host.close().
      const exit = app.exit.bind(app);
      app.exit = code => { setTimeout(() => exit(code), 100); };
      app.on('before-quit', () => {
        const timer = setInterval(() => {
          for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send('api-event', { topic: 'threads' });
        }, 1);
        timer.unref();
      });
    });
    return page;
  };
  const quit = async () => {
    if (!app) return;
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => app.quit());
    await closed; app = undefined;
    expect(rendererErrors).toEqual([]);
  };
  try {
    let page = await launch();
    const call = async <T>(method: string, args: unknown): Promise<T> => {
      const receipt = await api<Receipt<T>>(page, method, args);
      if (!receipt.ok) throw new Error(receipt.detail);
      return receipt.value;
    };
    const project = await call<{ id: string }>('projects.create', { name: 'Rewind files', kind: 'folder' });
    const settings: TurnSettings = { permission: 'full', model: 'rewind-script', effort: 3, runsOn: 'this-computer', mode: 'chat' };
    const send = async (text: string) => {
      const sent = await call<{ threadId: string }>('turns.send', { projectId: project.id, threadId, text, settings, attachments: [], clientKey: crypto.randomUUID() });
      threadId = sent.threadId;
      await expect.poll(async () => (await call<Thread>('threads.get', { id: threadId })).summary.running).toBe(false);
      expect((await call<Thread>('threads.get', { id: threadId })).turns.at(-1)!.status).toBe('done');
    };
    await send('Write stage one');
    await send('Write stage two');
    await page.reload();
    await page.getByRole('navigation').getByText('Write stage one', { exact: true }).click();
    await page.keyboard.press('ControlOrMeta+p');
    await page.getByTestId('file-row').filter({ hasText: 'brief.md' }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Edit brief.md' }).fill('My later edit');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const entries = await api<MaterialEntry[]>(page, 'material.list', { projectId: project.id });
    const brief = entries.find(entry => entry.name === 'brief.md')!;
    await expect.poll(async () => (await call<{ text: string }>('material.read', { id: brief.id })).text).toBe('My later edit');
    await page.getByRole('button', { name: 'Close brief.md' }).click();
    await page.getByRole('button', { name: 'Rewind to here', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Rewind conversation', exact: true });
    await expect(dialog.getByRole('link', { name: 'View later turns and their receipts' })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'View outside-action receipts' })).toHaveAttribute('href', /^#outside-receipts-/);
    await expect(dialog).toContainText('Sent mail stays sent');
    const confirm = dialog.getByRole('button', { name: 'Rewind conversation and files' });
    await expect(confirm).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('rewind-preview.png') });
    await dialog.getByRole('radio', { name: 'Keep my file' }).check();
    await confirm.click();
    await expect(dialog).not.toBeVisible();
    expect(rendererErrors).toEqual([]);
    await expect(page.getByTestId('turn')).toHaveCount(1);
    const visible = await api<MaterialEntry[]>(page, 'material.list', { projectId: project.id });
    expect(visible.map(entry => entry.name).sort()).toEqual(['brief.md', 'clean.md']);
    expect((await call<{ text: string }>('material.read', { id: visible.find(entry => entry.name === 'clean.md')!.id })).text).toBe('Clean one');
    expect((await call<{ text: string }>('material.read', { id: brief.id })).text).toBe('My later edit');
    await quit(); page = await launch();
    await page.getByRole('navigation').getByText('Write stage one', { exact: true }).click();
    await expect(page.getByTestId('turn')).toHaveCount(1);
    const history = page.getByTestId('rewind-history');
    await history.locator('summary').click();
    await expect(history).toContainText('Write stage two');
    await history.getByRole('link', { name: 'View receipts' }).click();
    await expect(history).toContainText('DONE');
    await expect(history).toContainText('new.md');
    await page.screenshot({ path: testInfo.outputPath('rewind-history.png') });
    // Continue on the kept branch: the provider receives no discarded conversation.
    await send('Continue after rewind');
    await expect(page.getByTestId('answer').last()).toContainText('Continued from stage one');
    expect(rendererErrors).toEqual([]);
  } catch (error) {
    const page = app?.windows()[0];
    if (page) await Promise.allSettled([
      page.screenshot({ path: testInfo.outputPath('rewind-failure.png') }),
      (async () => {
        const view = await page.evaluate(() => ({ body: document.body.innerText, ready: !!document.querySelector('[data-ready=true]'), turns: document.querySelectorAll('[data-testid=turn]').length, title: document.querySelector('[data-testid=thread-title]')?.textContent, history: !!document.querySelector('[data-testid=rewind-history]') }));
        const thread = threadId ? await api(page, 'threads.get', { id: threadId }) : null;
        const threads = await api(page, 'threads.list', {});
        const prefs = await api(page, 'viewer.get', {});
        await testInfo.attach('rewind-state-before-close', { body: JSON.stringify({ rendererErrors, view, thread, threads, prefs }, null, 2), contentType: 'application/json' });
      })(),
    ]);
    throw error;
  } finally { await quit(); await removeDataHome(home); await model.close(); }
});

test('a person sees an interrupted rewind after restart and records a finish without remaining files', async ({}, testInfo) => {
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  // A packaged app creates its own Keychain-backed vault; prepared test homes are plaintext.
  const home = installed ? mkdtempSync(join(tmpdir(), 'rewind-pending-installed-')) : freshDataHome('rewind-pending-electron');
  const userHome = join(home, 'test-person'); mkdirSync(userHome, { recursive: true });
  const model = await startScriptedModel('rewind-script', rewindStep);
  let app: ElectronApplication | undefined;
  let launches = 0;
  const launch = async () => {
    const launchNumber = ++launches;
    const stages: string[] = [];
    const env = { ...process.env, BACKBONE_HOME: home, BACKBONE_USER_HOME: userHome, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model } as Record<string, string>;
    app = await electron.launch(installed ? { executablePath: installed, args: [], env } : { args: [appDir], env });
    app.process().stderr?.on('data', data => {
      // Main's startup stages contain fixed class codes, never secrets or paths.
      for (const line of String(data).split('\n')) if (line.startsWith('[startup]')) stages.push(line);
    });
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    try { await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 }); }
    catch (error) {
      await testInfo.attach(`rewind-startup-${launchNumber}`, { body: JSON.stringify({ launchNumber, installed: !!installed, stages }), contentType: 'application/json' });
      throw error;
    }
    return page;
  };
  const quit = async () => {
    if (!app) return;
    const closed = app.waitForEvent('close'); await app.evaluate(({ app }) => app.quit()); await closed; app = undefined;
  };
  try {
    let page = await launch();
    const project = await api<Receipt<{ id: string }>>(page, 'projects.create', { name: 'Pending rewind', kind: 'folder' });
    if (!project.ok) throw new Error(project.detail);
    let threadId: string | undefined, firstTurn = '';
    for (const text of ['Write stage one', 'Write stage two']) {
      const sent = await api<Receipt<{ threadId: string; turnId: string }>>(page, 'turns.send', { projectId: project.value.id, threadId, text, settings: { permission: 'full', model: 'rewind-script', effort: 3, runsOn: 'this-computer', mode: 'chat' }, attachments: [], clientKey: crypto.randomUUID() });
      if (!sent.ok) throw new Error(sent.detail);
      threadId = sent.value.threadId; firstTurn ||= sent.value.turnId;
      await expect.poll(async () => {
        const thread = await api<Receipt<Thread>>(page, 'threads.get', { id: threadId });
        return thread.ok && !thread.value.summary.running;
      }).toBe(true);
    }
    // Deny the real app's folder move, while its private journal/version store stays writable.
    // The installed app owns this home throughout; no source Host needs its sealed keys.
    const projects = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as { id: string; dir: string }[];
    const projectFolder = join(home, 'projects', projects.find(entry => entry.id === project.value.id)!.dir);
    const mode = statSync(projectFolder).mode & 0o777;
    const args = { threadId: threadId!, turnId: firstTurn };
    const plan = await api<Receipt<import('@backbone-next/platform').RewindPlan>>(page, 'threads.rewindPreview', args);
    if (!plan.ok) throw new Error(plan.detail);
    assertHomeWriteAdmission(home);
    chmodSync(projectFolder, 0o500);
    try {
      expect((await api<Receipt<unknown>>(page, 'threads.rewind', { ...args, revision: plan.value.revision, clientKey: 'pending-ui', choices: [] })).ok).toBe(false);
      const pending = await api<Receipt<Thread>>(page, 'threads.get', { id: threadId });
      expect(pending.ok && pending.value.rewindPending?.turnId).toBe(firstTurn);
    } finally { assertHomeWriteAdmission(home); chmodSync(projectFolder, mode); }
    await quit();
    page = await launch();
    await page.getByRole('navigation').getByText('Write stage one', { exact: true }).click();
    const banner = page.getByTestId('pending-rewind');
    await expect(banner).toContainText('unfinished rewind');
    await page.screenshot({ path: testInfo.outputPath('rewind-pending.png') });
    await banner.getByRole('button', { name: 'Resume rewind', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Rewind conversation', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await banner.getByRole('button', { name: 'Finish without restoring remaining files', exact: true }).click();
    await expect(banner).not.toBeVisible();
    await expect(page.getByTestId('turn')).toHaveCount(1);
    const history = page.getByTestId('rewind-history'); await history.locator('summary').click();
    await expect(history).toContainText('Finished without restoring remaining files');
    await expect(history.locator('[data-outcome="not-restored"]').first()).toBeVisible();
    await expect(history.locator('[data-outcome="restored"]').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('rewind-finish.png') });
  } finally { await quit(); await removeDataHome(home); await model.close(); }
});
