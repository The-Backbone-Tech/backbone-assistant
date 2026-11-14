// A person defines a role in Settings, restarts the app and reuses it for two helpers.
// BACKBONE_APP_EXECUTABLE selects the app installed from our DMG; all model traffic is loopback.
import { _electron, expect, test, type ElectronApplication, type TestInfo } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { startScriptedModel, type Message, type Step } from '@backbone-next/platform/testing';
import { api, appDir, openSidebar } from './journey';
import type { Receipt, Thread } from '@backbone-next/platform';

const text = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join('');
function step(messages: Message[]): Step {
  const index = messages.findLastIndex(m => m.role === 'user');
  const words = text(messages[index]);
  const results = messages.slice(index + 1).filter(m => m.role === 'tool').map(text);
  if (words.includes('ROLE_PROBE')) {
    if (!results.length) return { calls: [{ name: 'list_files', args: {} }] };
    return { text: 'Role evidence collected: ' + results.join('\n') };
  }
  if (words.includes('Use own/researcher')) {
    if (!results.length) return { calls: [{ name: 'start_child', args: { agent: 'own/researcher', role: 'worker', brief: 'Inspect the project' } }] };
    const id = /Started thread (\S+)/.exec(results[0])?.[1];
    if (id && results.length === 1) return { calls: [{ name: 'await_child', args: { thread: id } }] };
    return { text: 'Helpers finished. ' + results.join('\n') };
  }
  return { text: 'Ready.' };
}

async function roleJourney({}: {}, info: TestInfo) {
  const home = mkdtempSync(join(tmpdir(), 'agent-roles-installed-'));
  const person = mkdtempSync(join(tmpdir(), 'agent-roles-person-'));
  const model = await startScriptedModel('parent-model', step, { served: ['parent-model', 'role-model'] });
  let app: ElectronApplication | undefined;
  let appProcess: ChildProcess | undefined;
  const launch = async () => {
    const installed = process.env.BACKBONE_APP_EXECUTABLE;
    // Isolate tool discovery without changing the OS home used by native Keychain.
    app = await _electron.launch({ ...(installed ? { executablePath: installed, args: [] } : { args: [appDir] }), env: { ...process.env, BACKBONE_HOME: home, BACKBONE_USER_HOME: person, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model } });
    appProcess = app.process();
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 });
    return page;
  };
  const quit = async () => {
    if (!app) return;
    const current = app;
    const proc = appProcess!;
    // Use Electron's shutdown and retain the live child handle: Playwright disposes its
    // application object on close, before the exit-code assertion below.
    if (proc.exitCode === null && proc.signalCode === null) {
      const closed = current.waitForEvent('close', { timeout: 30_000 });
      await Promise.all([closed, current.evaluate(({ app }) => { setImmediate(() => app.quit()); })]);
    }
    await expect.poll(() => proc.exitCode, { timeout: 5_000 }).toBe(0);
    app = undefined;
    appProcess = undefined;
  };
  const definition = '---\nname: researcher\ndescription: Finds project evidence\nmodel: role-model\ntools: [Read, Glob]\n---\nROLE_PROBE: cite the evidence.\n';
  try {
    let page = await launch();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    let settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Agent roles', exact: true }).click();
    await settings.getByRole('textbox', { name: 'Agent role definition' }).fill(definition);
    await settings.getByRole('button', { name: 'Save role', exact: true }).click();
    await expect(settings.getByRole('status')).toBeVisible();
    await settings.getByRole('textbox', { name: 'Agent role definition' }).fill(definition.replace('cite the evidence.', 'cite evidence and dates.'));
    await settings.getByRole('button', { name: 'Save role', exact: true }).click();
    await expect(settings.getByRole('status')).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(settings.getByRole('textbox', { name: 'Agent role definition' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath('agent-roles-narrow.png') });
    await test.step('Quit the process before cold start', quit);
    page = await test.step('Cold start the saved role home', launch);
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Agent roles', exact: true }).click();
    await settings.getByRole('button', { name: 'researcher', exact: true }).click();
    await expect(settings.getByRole('textbox', { name: 'Agent role definition' })).toHaveValue(/cite evidence and dates/);
    await settings.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Role evidence');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    for (const message of ['Use own/researcher', 'Use own/researcher again']) {
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(message);
      await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
      await expect.poll(async () => {
        const threads = await api<{ id: string; parentId?: string; running: boolean }[]>(page, 'threads.list', {});
        return { children: threads.filter(t => !!t.parentId && !t.running).length, running: threads.some(t => t.running) };
      }, { timeout: 60_000 }).toEqual({ children: message.endsWith('again') ? 2 : 1, running: false });
    }
    const threads = await api<{ id: string; parentId?: string }[]>(page, 'threads.list', {});
    const children = threads.filter(t => t.parentId);
    expect(children).toHaveLength(2);
    for (const child of children) {
      const result = await api<Receipt<Thread>>(page, 'threads.get', { id: child.id });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.detail);
      expect(result.value.child?.settings.model).toBe('role-model');
      expect(result.value.child?.agentRole?.tools).toEqual(['Read', 'Glob']);
      expect(result.value.turns[0].status).toBe('done');
      expect(result.value.turns[0].work.steps.some(step => step.kind === 'list')).toBe(true);
    }
    const childRequests = model.requests.filter(r => r.body).map(r => JSON.parse(r.body)).filter(r => r.messages.some((m: Message) => m.role === 'user' && text(m).includes('ROLE_PROBE')));
    expect(childRequests.length).toBeGreaterThanOrEqual(4);
    expect(childRequests.every(r => r.model === 'role-model')).toBe(true);
    expect(childRequests.every(r => !(r.tools ?? []).some((t: { function: { name: string } }) => ['workspace_run', 'start_child', 'memory_search'].includes(t.function.name)))).toBe(true);
    await openSidebar(page);
    await page.getByRole('button', { name: 'Show child threads', exact: true }).click();
    await page.getByRole('navigation', { name: 'Projects and threads' }).getByRole('button', { name: /own\/researcher:/ }).first().click();
    await expect(page.getByTestId('fork-role-notice')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Agent roles', exact: true }).click();
    await settings.getByRole('button', { name: 'researcher', exact: true }).click();
    await settings.getByRole('button', { name: 'Delete role', exact: true }).click();
    await expect(settings.getByRole('status')).toBeVisible();
    await expect(settings.getByRole('button', { name: 'researcher', exact: true })).toHaveCount(0);
  } finally {
    try { await quit(); }
    finally {
      // A failed quit must still stop this fixture's process before disposing its home and server.
      if (appProcess) {
        const proc = appProcess;
        if (proc.exitCode === null && proc.signalCode === null) {
          const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
          proc.kill('SIGKILL');
          await exited;
        }
      }
      await model.close(); await removeDataHome(home); rmSync(person, { recursive: true, force: true });
    }
  }

}

// Keep both deployment checks, and let only an installed execution satisfy the journey proof.
if (process.env.BACKBONE_APP_EXECUTABLE) {
  test('a person saves, edits, restarts and reuses a custom agent role with its model and tool ceiling', roleJourney);
} else {
  test('the unpacked app saves and reuses agent roles with model and tool limits', roleJourney);
}
