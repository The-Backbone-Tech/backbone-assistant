import { freshAcpExecutableDirectory } from '@backbone-next/platform/testing/acp';
// Local app bridge, real Host/Core and a disposable ACP process. No vendor account or model call.
import type { Turn } from '@backbone-next/platform';
import { expect, test, type Request } from '@playwright/test';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startBridge, stopBridge } from './bridge';
import { api, closeSidebar, openSidebar } from './journey';

test('a person configures an ACP agent, restarts, and receives a document with its receipt', async ({ page }) => {
  const home = freshDataHome('acp-settings');
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge(home, { BACKBONE_HARNESS: 'harness-stub', BACKBONE_USER_HOME: home, BACKBONE_MODEL_ENDPOINT: undefined, ACP_FAKE_MODE: 'mcp-write' });
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'AI and models', exact: true }).click();
    const form = dialog.getByRole('form', { name: 'ACP agent', exact: true });
    await expect(form.getByRole('button', { name: 'Save ACP agent' })).toBeDisabled();
    await expect(form).toContainText('@agentclientprotocol/claude-agent-acp');
    await form.getByLabel('Agent setup').selectOption('custom');
    await form.getByLabel('Agent name', { exact: true }).fill('owned-test-agent');
    await form.getByLabel('Executable', { exact: true }).fill(process.execPath);
    await form.getByLabel('Arguments', { exact: true }).fill(JSON.stringify([new URL('../../../modules/harness-acp/test/fake-agent.mjs', import.meta.url).pathname]));
    await form.getByLabel('Environment variable names', { exact: true }).fill('ACP_FAKE_MODE');
    if (process.platform !== 'darwin') await form.getByLabel('Agent rights').selectOption('person-rights');
    await form.getByRole('button', { name: 'Resolve executable', exact: true }).click();
    await expect(form.getByLabel('Resolved executable', { exact: true })).toContainText(/^\//);
    for (const checkbox of await form.getByRole('checkbox').all()) await checkbox.check();
    // Acceptance belongs to the program and arguments the person inspected, not the form.
    const originalCommand = await form.getByLabel('Executable', { exact: true }).inputValue();
    const originalArgs = await form.getByLabel('Arguments', { exact: true }).inputValue();
    for (const [label, changed, original] of [
      ['Executable', `${originalCommand}-changed`, originalCommand],
      ['Arguments', '["--changed"]', originalArgs],
    ]) {
      await form.getByLabel(label, { exact: true }).fill(changed);
      await expect(form.getByRole('button', { name: 'Save ACP agent' })).toBeDisabled();
      await expect(form.getByLabel('Resolved executable', { exact: true })).toHaveCount(0);
      for (const checkbox of await form.getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked();
      await form.getByLabel(label, { exact: true }).fill(original);
      await form.getByRole('button', { name: 'Resolve executable', exact: true }).click();
      await expect(form.getByLabel('Resolved executable', { exact: true })).toContainText(/^\//);
      for (const checkbox of await form.getByRole('checkbox').all()) await checkbox.check();
    }
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', page.viewportSize()!.width);
    await form.screenshot({ path: test.info().outputPath('acp-settings.png') });
    await form.getByRole('button', { name: 'Save ACP agent' }).click();
    await expect(form.getByRole('status', { name: 'Agent save result', exact: true })).toBeVisible();
    const stored = readFileSync(join(home, 'settings.json'), 'utf8');
    expect(JSON.parse(stored).harnesses['harness-acp'].environmentVariables).toEqual(['ACP_FAKE_MODE']);
    expect(stored).not.toContain('mcp-write');
    await stopBridge(bridge.proc); bridge = undefined;
    bridge = await startBridge(home, { BACKBONE_HARNESS: undefined, BACKBONE_USER_HOME: home, BACKBONE_MODEL_ENDPOINT: undefined, ACP_FAKE_MODE: 'mcp-write' });
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('ACP work');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await closeSidebar(page);
    const model = await api<{ active: { kind: string } }>(page, 'settings.model.get', {});
    expect(model.active.kind).toBe('agent');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Write a brief');
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await expect.poll(async () => {
      const threads = await api<{ id: string }[]>(page, 'threads.list', {});
      if (!threads.length) return false;
      const result = await api<{ value: { turns: { status: string; effects: { outcome: string; version?: number; sha256?: string }[] }[] } }>(page, 'threads.get', { id: threads[0].id });
      const turn = result.value.turns[0];
      return turn?.status === 'done' && turn.effects.some(effect => effect.outcome === 'DONE' && effect.version && effect.sha256);
    }).toBeTruthy();
    await page.keyboard.press('ControlOrMeta+p');
    await expect(page.getByTestId('file-row').filter({ hasText: 'brief.md' })).toBeVisible();
  } finally {
    if (bridge) await stopBridge(bridge.proc);
    await removeDataHome(home);
  }
});

test('Claude setup uses machine sign-in and refuses a signed-out client without launching the adapter', async ({ page }) => {
  const home = freshDataHome('claude-settings'), person = freshAcpExecutableDirectory('claude-settings-person-');
  const cli = join(person, 'claude'), marker = join(person, 'adapter-started'), probes = join(person, 'sign-in-probes');
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' probe >> '${probes}'\nprintf '%s' '{"loggedIn":false,"authMethod":"none","email":"private-account-canary"}'\nexit 1\n`); chmodSync(cli, 0o755);
  const env = { HOME: person, CLAUDE_CODE_EXECUTABLE: cli, CLAUDE_CONFIG_DIR: join(person, '.claude'), BACKBONE_USER_HOME: person, BACKBONE_MODEL_ENDPOINT: undefined };
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge(home, { ...env, BACKBONE_HARNESS: 'harness-stub' });
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'AI and models', exact: true }).click();
    const form = dialog.getByRole('form', { name: 'ACP agent', exact: true });
    await expect(form.getByLabel('Agent rights')).toHaveValue('person-rights');
    await expect(form.getByLabel('Agent rights')).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Save ACP agent' })).toBeDisabled();
    await form.getByLabel('Executable', { exact: true }).fill(process.execPath);
    await form.getByLabel('Arguments', { exact: true }).fill(JSON.stringify(['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`]));
    await form.getByRole('button', { name: 'Resolve executable', exact: true }).click();
    await expect(form.getByLabel('Resolved executable', { exact: true })).toContainText(/^\//);
    for (const checkbox of await form.getByRole('checkbox').all()) await checkbox.check();
    await expect(form.getByRole('checkbox', { name: /read and write.*settings.json.*credentials/ })).toBeChecked();
    const acceptedCommand = await form.getByLabel('Executable', { exact: true }).inputValue();
    const acceptedArgs = await form.getByLabel('Arguments', { exact: true }).inputValue();
    for (const [label, changed, original] of [
      ['Executable', `${acceptedCommand}-changed`, acceptedCommand],
      ['Arguments', '["--changed"]', acceptedArgs],
    ]) {
      await form.getByLabel(label, { exact: true }).fill(changed);
      for (const checkbox of await form.getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked();
      await expect(form.getByRole('button', { name: 'Save ACP agent' })).toBeDisabled();
      await form.getByLabel(label, { exact: true }).fill(original);
      await form.getByRole('button', { name: 'Resolve executable', exact: true }).click();
      await expect(form.getByLabel('Resolved executable', { exact: true })).toContainText(/^\//);
      const consents = await form.getByRole('checkbox').all();
      for (const checkbox of consents) await expect(checkbox).not.toBeChecked();
      await consents[0].check();
      await expect(form.getByRole('button', { name: 'Save ACP agent' })).toBeDisabled();
      await consents[1].check();
    }
    await form.getByRole('button', { name: 'Save ACP agent' }).click();
    await expect(form.getByRole('status', { name: 'Agent save result', exact: true })).toBeVisible();
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).harnesses['harness-acp']).toMatchObject({ machineClient: 'claude', environment: 'person-rights', acceptsProcessVisibility: true });
    await stopBridge(bridge.proc); bridge = undefined;
    bridge = await startBridge(home, { ...env, BACKBONE_HARNESS: undefined });
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await expect.poll(async () => await api(page, 'settings.model.get', {})).toMatchObject({ machineClient: 'claude', machineClientState: { state: 'signed-out', source: 'claude auth status --json' } });
    const model = await api(page, 'settings.model.get', {});
    expect(JSON.stringify(model)).not.toContain('private-account-canary');
    const beforeSettings = readFileSync(join(home, 'settings.json'), 'utf8');
    const probeCount = () => readFileSync(probes, 'utf8').trim().split('\n').length;
    const probesBeforeOpen = probeCount();
    const puts: { change: { route: string } }[] = [];
    const observe = (request: Request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api') {
        const body = request.postDataJSON();
        if (body.method === 'settings.model.put') puts.push(body.args);
      }
    };
    page.on('request', observe);
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const reopened = page.getByRole('dialog', { name: 'Settings' });
    await reopened.getByRole('button', { name: 'AI and models', exact: true }).click();
    const refresh = reopened.getByRole('button', { name: 'Refresh engine sign-in', exact: true });
    await expect(refresh).toBeVisible();
    expect(puts).toEqual([]);
    expect(probeCount()).toBe(probesBeforeOpen);
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe(beforeSettings);
    await refresh.click();
    await expect.poll(probeCount).toBe(probesBeforeOpen + 1);
    await expect(refresh).toBeEnabled();
    expect(puts).toHaveLength(1);
    expect(puts[0].change.route).toBe('agent-refresh');
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe(beforeSettings);
    page.off('request', observe);
    await page.keyboard.press('Escape');
    await expect(reopened).toBeHidden();
    await closeSidebar(page);
    await openSidebar(page);
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Claude refusal');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await closeSidebar(page);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Write a brief');
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await expect.poll(async () => {
      const threads = await api<{ id: string }[]>(page, 'threads.list', {});
      if (!threads.length) return undefined;
      const result = await api<{ value: { turns: Turn[] } }>(page, 'threads.get', { id: threads[0].id });
      const turn = result.value.turns[0], detail = turn?.failure?.detail ?? turn?.refusal?.detail ?? '';
      return !!turn && ['stopped', 'refused'].includes(turn.status) && /signed-out/.test(detail)
        && /claude auth status --json/.test(detail) && turn.effects.length === 0;
    }).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (bridge) await stopBridge(bridge.proc);
    await removeDataHome(home); rmSync(person, { recursive: true, force: true });
  }
});
