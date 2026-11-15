// A plugin's command as a person meets it, on the browser bridge: Settings lists the commands, agents
// and hooks of the Claude Code plugins they enabled, each off; they enable a command, type it in the
// composer as /name with its arguments, and the chat shows the filled template as their message. A hook
// is listed as not run, and nothing of it runs. A temporary folder stands in for the person's home.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel, scriptedStep, type Message, type Step } from '@backbone-next/platform/testing';
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, stopBridge } from './bridge';
import { api } from './journey';

test('a person enables a plugin command in Settings and invokes it from the composer; a hook is never run', async ({ page }) => {
  const home = freshDataHome('plugin-command');
  const user = mkdtempSync(join(tmpdir(), 'plugin-user-'));
  const marker = join(user, 'hook-ran');
  const install = join(user, '.claude', 'plugins', 'cache', 'market', 'tools', '1.0.0');
  mkdirSync(join(install, 'commands'), { recursive: true });
  mkdirSync(join(install, 'agents'));
  mkdirSync(join(install, 'hooks'));
  writeFileSync(join(install, 'commands', 'greet.md'), '---\ndescription: Greet someone by name\nargument-hint: <name>\n---\nSay hello to $1 and wish them a good week.\n');
  writeFileSync(join(install, 'agents', 'researcher.md'), '---\nname: researcher\ndescription: Finds facts in the notes\ntools: Bash, Write\n---\nYou are a careful researcher.\n');
  writeFileSync(join(install, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] } }));
  writeFileSync(join(user, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@market': true } }));
  writeFileSync(join(user, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tools@market': [{ scope: 'user', installPath: install, version: '1.0.0' }] } }));
  process.env.BACKBONE_USER_HOME = user;
  const bridge = await startBridge(home);
  delete process.env.BACKBONE_USER_HOME;
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await api(page, 'projects.create', { name: 'Ops', kind: 'folder' });
    await page.reload();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Plugins', exact: true }).click();
    const plugin = dialog.getByRole('region', { name: 'tools@market' });
    const greet = plugin.getByTestId('plugin-part').filter({ hasText: '/greet' });
    await expect(greet).toContainText('Off');
    await expect(plugin.getByTestId('plugin-part').filter({ hasText: 'researcher' })).toContainText('Declares tools: Bash, Write.');
    await expect(plugin.getByTestId('plugin-part').filter({ hasText: 'researcher' })).toContainText('grant nothing');
    const hook = plugin.getByTestId('plugin-part').filter({ hasText: 'SessionStart' });
    await expect(hook).toContainText(/Not run: hooks execute commands; \S+ does not run them/);
    await expect(hook.getByRole('button')).toHaveCount(0);
    await greet.getByRole('button', { name: 'Enable' }).click();
    await expect(greet).toContainText('On');
    await dialog.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('navigation').getByRole('button', { name: 'Ops', exact: true }).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('/gr');
    await expect(page.getByTestId('command-hint')).toContainText('/greet <name> · Greet someone by name');
    await box.fill('/greet Ana');
    await box.press('Enter');
    await expect(page.getByTestId('turn').first()).toContainText('Say hello to Ana and wish them a good week.');
    expect(existsSync(marker), 'no hook ran').toBe(false);
  } finally {
    await stopBridge(bridge.proc);
    await removeDataHome(home);
    rmSync(user, { recursive: true, force: true });
  }
});

/** A real engine on a scripted model: a "Hold on" turn keeps listing files until `holding` ends. */
let holding = false;
const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
function stepped(messages: Message[]): Step {
  if (!messages.some((m) => m.role === 'user' && /Hold on/.test(words(m)))) return scriptedStep(messages);
  return holding ? { calls: [{ name: 'list_files', args: {} }] } : { text: 'Finished holding.' };
}

test('a /command typed while a turn runs is filled when it steers the turn, not only when it is queued', async ({ page }) => {
  const model = await startScriptedModel('scripted-model', stepped);
  const home = freshDataHome('plugin-steer');
  const user = mkdtempSync(join(tmpdir(), 'plugin-user-'));
  const install = join(user, '.claude', 'plugins', 'cache', 'market', 'tools', '1.0.0');
  mkdirSync(join(install, 'commands'), { recursive: true });
  writeFileSync(join(install, 'commands', 'focus.md'), '---\ndescription: Narrow the work\n---\nFocus only on $ARGUMENTS from now on.\n');
  writeFileSync(join(user, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@market': true } }));
  writeFileSync(join(user, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tools@market': [{ scope: 'user', installPath: install, version: '1.0.0' }] } }));
  const env = { BACKBONE_USER_HOME: user, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model };
  Object.assign(process.env, env);
  const bridge = await startBridge(home);
  for (const name of Object.keys(env)) delete process.env[name];
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    const focus = (await api<{ id: string; name: string; digest: string }[]>(page, 'plugins.parts', {})).find((p) => p.name === 'focus')!;
    await api(page, 'plugins.decide', { id: focus.id, verdict: 'enable', digest: focus.digest });
    const p = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Ops', kind: 'folder' });
    const settings = { permission: 'ask', model: 'stub', effort: 2, runsOn: 'this-computer', mode: 'chat' };
    const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId: p.value.id, text: 'Hello', attachments: [], settings, clientKey: 'first' });
    const threadId = sent.value.threadId;
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: threadId })).value.summary.running).toBe(false);
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Ops', exact: true }).click();
    await page.getByRole('navigation').getByText('Hello').first().click();
    holding = true;
    await api(page, 'turns.send', { threadId, projectId: p.value.id, text: 'Hold on', attachments: [], settings, clientKey: 'hold' });
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

    // The enabled command reaches the composer asynchronously; under load, steer only once it is offered.
    await page.getByRole('textbox', { name: 'Message' }).fill('/focus');
    await expect(page.getByTestId('command-hint')).toContainText('/focus');
    await page.getByRole('textbox', { name: 'Message' }).fill('/focus the tests');
    await page.getByRole('button', { name: 'Steer' }).click();
    const steer = page.getByTestId('turn-steer');
    await expect(steer).toContainText('Focus only on the tests from now on.');
    await expect(steer).not.toContainText('/focus');
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  } finally {
    holding = false;
    await stopBridge(bridge.proc);
    await removeDataHome(home);
    await model.close();
    rmSync(user, { recursive: true, force: true });
  }
});
