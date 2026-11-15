// Settings as a person finds their way around it, on the actual renderer: groups named by the decision,
// every section reachable from its group by keyboard, search by old and new names, and the engine chosen
// in the app through `settings.engine.put`, with its restart notice, unavailable engines and refusals.
// Synthetic receipts stand in for the host; no data folder, account or model is used.
// Set BACKBONE_SETTINGS_SHOTS to a folder to keep the finished states as PNG files.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { DEFAULT_PREFS } from '@backbone-next/platform';

let server: ViteDevServer, url: string;
test.setTimeout(60_000);
test.beforeAll(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen(); url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

const GROUPS = ['You', 'AI', 'Apps and tools', 'Team', 'This computer'];
const SECTIONS = ['General', 'AI and models', 'Helper roles', 'Connected tools', 'Tool permissions', 'Plugins', 'Assistants using this app', 'People and roles', 'Sharing', 'Heartbeat and brief', 'Backup', 'Telemetry', 'Licences and notices'];

// `build` is what the app says about itself: an unpacked development build offers the practice engine.
async function open(page: Page, fixture: { policy?: boolean; build?: 'development' | 'installed'; environment?: boolean } = {}) {
  await page.addInitScript(({ prefs, policy, build, environment }) => {
    const owner = { id: 'owner', name: 'Ana Ortega', role: 'owner', status: 'active' };
    const colleague = { id: 'colleague', name: 'Colleague', role: 'member', status: 'active' };
    const engine = (name: string, id: string, label: string, about: string, state: string, reason?: string) => ({ name, id, label, about, state, ...(reason ? { reason } : {}) });
    const refused = 'Your organisation’s managed policy does not allow this engine.';
    const state = {
      mode: 'allowed', noModel: false, puts: [] as unknown[], reads: 0, fresh: 0, failReads: false,
      engines: { running: 'harness-pi', next: 'harness-pi', stored: null as string | null, environment: !!environment, options: [
        engine('pi', 'harness-pi', 'Pi', 'Runs on the model you choose below, with this app’s own tools.', policy ? 'refused' : 'available', policy ? refused : undefined),
        engine('codex', 'harness-codex', 'Codex', 'Runs inside the Codex app installed on this computer, with its own tools and sign-in.', policy ? 'refused' : 'unavailable', policy ? refused : 'Codex is not installed on this computer. Install it and sign in through Codex itself, then check again.'),
        engine('acp', 'harness-acp', 'Claude or your own agent (ACP)', 'Runs the agent you set up below.', policy ? 'refused' : 'unavailable', policy ? refused : 'No agent is set up yet.'),
        engine('stub', 'harness-stub', 'Practice', 'Answers with fixed practice text. No model is called.', 'available'),
      ] },
    };
    const model = {
      harness: 'Pi · Local endpoint · llama3.2', hint: null, own: null, gateway: null,
      local: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' },
      active: { kind: 'endpoint', label: 'Local endpoint · llama3.2', model: 'llama3.2' },
      shared: { hint: null, own: null, local: null, gateway: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', keySet: true }, active: { kind: 'gateway', label: 'OpenRouter · anthropic/claude-sonnet-5.5', model: 'anthropic/claude-sonnet-5.5' } },
    };
    Object.assign(window, { settingsFixture: state, backbone: {
      platform: 'linux', setTheme() {}, onEvent() { return () => {}; },
      ...(build ? { appInfo: async () => ({ packaged: build === 'installed', version: '0.0.0' }) } : {}),
      async call(method: string, args: any) {
        if (method === 'host.status') return { owns: true };
        if (method === 'settings.policy.get') return policy ? { state: 'verified', id: 'company-policy', version: 2, fixed: ['harnesses'], descriptions: { harnesses: 'the engines a person may choose' }, warnings: [] } : { state: 'none' };
        if (method === 'viewer.get') return { ...prefs, selectedProjectId: 'project', pane: { open: false, tabs: [] } };
        if (method === 'viewer.put') return args.prefs;
        if (method === 'projects.list') return [{ id: 'project', name: 'Shared project', kind: 'folder', createdAt: '2026-11-14T09:00:00Z' }];
        if (['threads.list', 'models.list', 'plugins.parts', 'material.list', 'files.list'].includes(method)) return [];
        if (method === 'work.now') return { needsYou: [], running: [], progress: [], current: [], temporary: [], withdrawn: [], retired: [] };
        if (method === 'drafts.get') return null;
        if (method === 'identity.get') return { ok: true, value: { person: owner, people: [owner, colleague], deviceOwner: true } };
        if (method === 'identity.automations') return { ok: true, value: [] };
        if (method === 'identity.sharing') return { ok: true, value: { access: 'owner', nativeAccountTools: false, people: [owner, colleague], grants: [] } };
        if (method === 'settings.model.get') {
          // The platform's own no-model sentence, as the chat and the terminal receive it.
          const none = 'No model is set up yet. Open Settings (the gear in the sidebar), then paste your own Anthropic or OpenAI key, or a Vercel AI Gateway or OpenRouter key, or choose a model running on this computer. Nothing was sent.';
          return state.noModel ? { harness: 'Pi', hint: none, own: null, gateway: null, local: null, active: null, shared: { hint: none, own: null, gateway: null, local: null, active: null } } : structuredClone(model);
        }
        if (method === 'models.local') return { runtimes: [{ provider: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: ['llama3.2'] }] };
        if (method === 'settings.engines.get') { state.reads++; if (args?.fresh) state.fresh++; if (state.failReads) throw new Error('private-read-error-canary'); return structuredClone(state.engines); }
        if (method === 'settings.engine.put') {
          state.puts.push(args);
          if (state.mode === 'refused') return { ok: false, outcome: 'REFUSED', reason: 'INVALID', detail: 'This controlled test refuses the engine.' };
          if (state.mode === 'lost') throw new Error('private-transport-error-canary');
          const chosen = state.engines.options.find(o => o.name === args.engine)!;
          state.engines.stored = chosen.id;
          if (!state.engines.environment) state.engines.next = chosen.id;
          return { ok: true, value: { engine: chosen.id, detail: 'Saved.' } };
        }
        if (method === 'tools.list') return { available: false, tools: [] };
        if (method === 'connectors.list') return { egress: 'per-server', held: [], servers: [] };
        if (method === 'agents.list') return { ok: true, value: { roles: [], truncated: false, manualReview: false } };
        if (method === 'schedules.get') return { schedules: [], heartbeat: null, brief: { time: '08:00' } };
        if (method === 'triggers.get') return { triggers: [] };
        return null;
      },
    } });
  }, { prefs: DEFAULT_PREFS, policy: !!fixture.policy, build: fixture.build, environment: !!fixture.environment });
  await page.goto(url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  await openSettings(page);
  return page.getByRole('dialog', { name: 'Settings' });
}
async function openSettings(page: Page) {
  const settings = page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).first();
  if (!await settings.isVisible()) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await settings.click();
}

const narrow = (page: Page) => page.viewportSize()!.width < 640;
const nav = (dialog: Locator) => dialog.getByRole('navigation', { name: 'Settings sections' });
async function section(page: Page, dialog: Locator, name: string) {
  if (narrow(page) && await dialog.getByRole('button', { name: 'All settings' }).isVisible()) await dialog.getByRole('button', { name: 'All settings' }).click();
  await nav(dialog).getByRole('button', { name, exact: true }).click();
  await expect(dialog.locator('#settings-section-title')).toHaveText(name);
  if (!narrow(page)) await expect(nav(dialog).locator('[aria-current=page]')).toHaveText(name);
}
const fixture = (page: Page) => page.evaluate(() => (window as any).settingsFixture as { puts: { engine: string }[]; reads: number; fresh: number });
const failReads = (page: Page, value: boolean) => page.evaluate(value => { (window as any).settingsFixture.failReads = value; }, value);
const mode = (page: Page, value: string) => page.evaluate(value => { (window as any).settingsFixture.mode = value; }, value);
async function shot(page: Page, name: string) {
  const folder = process.env.BACKBONE_SETTINGS_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  // Away from any row, and with transitions finished, so a hover fading out is not mistaken for a selection.
  await page.mouse.move(1, 1);
  await page.screenshot({ animations: 'disabled', path: join(folder, `${test.info().project.name.replace(/^browser-/, '')}-${name}.png`) });
}

test('sections are grouped by the decision and every one is reachable from its group by keyboard', async ({ page }) => {
  const dialog = await open(page);
  await expect(nav(dialog).getByRole('heading')).toHaveText(GROUPS);
  await expect(nav(dialog).getByRole('button')).toHaveText(SECTIONS);
  await expect(nav(dialog).getByRole('group', { name: 'AI' }).getByRole('button')).toHaveText(['AI and models', 'Helper roles']);
  await expect(nav(dialog).getByRole('group', { name: 'Apps and tools' }).getByRole('button')).toHaveText(['Connected tools', 'Tool permissions', 'Plugins', 'Assistants using this app']);
  await expect(nav(dialog).getByRole('group', { name: 'This computer' }).getByRole('button')).toHaveText(['Heartbeat and brief', 'Backup', 'Telemetry', 'Licences and notices']);
  await shot(page, '01-settings-list');
  // The three look-alikes each say which way they go.
  await expect(nav(dialog).getByRole('button', { name: 'Connected tools', exact: true })).toHaveAttribute('title', /apps this assistant can use/i);
  await expect(nav(dialog).getByRole('button', { name: 'Assistants using this app', exact: true })).toHaveAttribute('title', /other assistants that may act through this one/i);
  await expect(nav(dialog).getByRole('button', { name: 'Tool permissions', exact: true })).toHaveAttribute('title', /what may act without asking you first/i);

  await dialog.getByRole('searchbox', { name: 'Search settings' }).focus();
  for (const name of SECTIONS) {
    await page.keyboard.press('Tab');
    await expect(nav(dialog).getByRole('button', { name, exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog.locator('#settings-section-title')).toHaveText(name);
    if (!narrow(page)) await expect(nav(dialog).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
    if (narrow(page)) {
      // On a narrow window the list and the section take turns; going back returns focus to the list.
      await expect(dialog.getByRole('button', { name: 'All settings' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(nav(dialog).getByRole('button', { name, exact: true })).toBeFocused();
      await expect(nav(dialog).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
    }
  }
  await section(page, dialog, 'General');
  // A segmented choice is a radio group: the arrow keys move and choose.
  const appearance = dialog.getByRole('radiogroup', { name: 'Appearance' });
  await appearance.getByRole('radio', { name: 'System' }).focus();
  // Held as a person's key is: the radio is chosen as focus arrives, while the key is down.
  await page.keyboard.down('ArrowRight');
  await expect(appearance.getByRole('radio', { name: 'Light' })).toBeFocused();
  await page.keyboard.up('ArrowRight');
  await expect(appearance.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await appearance.getByRole('radio', { name: 'System' }).click();
  await expect(appearance.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
  await shot(page, '02-settings-general');
});

test('search finds each renamed section by its old and its new words', async ({ page }) => {
  const dialog = await open(page);
  const search = dialog.getByRole('searchbox', { name: 'Search settings' });
  for (const [words, name] of [
    ['Connect your AI tools', 'Assistants using this app'], ['assistants using', 'Assistants using this app'],
    ['Agent roles', 'Helper roles'], ['helper roles', 'Helper roles'],
    ['Plugin commands and agents', 'Plugins'], ['plugins', 'Plugins'],
  ]) {
    await search.fill(words);
    await expect(nav(dialog).getByRole('button')).toHaveText([name]);
  }
  await search.fill('engine');
  await expect(nav(dialog).getByRole('button')).toHaveText(['AI and models']);
  await search.fill('no such words here');
  await expect(nav(dialog)).toContainText('No setting matches');
});

test('the engine is chosen in the app, applies at the next start and says what cannot run here', async ({ page }) => {
  const dialog = await open(page, { build: 'development' });
  await section(page, dialog, 'AI and models');
  const engine = dialog.getByRole('region', { name: 'Engine' });
  await expect(engine.getByTestId('engine-current')).toContainText('In use now: Pi');
  // Engine first, then your model, then shared work, each with its current value before any form.
  await expect(dialog.getByRole('region', { name: /^(Engine|Your model|Shared work)$/ })).toHaveText([/^Engine/, /^Your model/, /^Shared work/]);
  await expect(dialog.getByTestId('model-active')).toContainText('Local endpoint · llama3.2');
  await expect(dialog.getByTestId('shared-model-route')).toContainText('OpenRouter · anthropic/claude-sonnet-5.5');
  await expect(dialog.getByRole('form', { name: 'Your own key', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('radiogroup', { name: 'Engine' })).toHaveCount(0);

  await engine.getByText('Change engine', { exact: true }).click();
  const choices = engine.getByRole('radiogroup', { name: 'Engine' });
  await expect(choices.getByRole('radio')).toHaveCount(4);
  await expect(choices.getByRole('radio', { name: 'Pi' })).toBeChecked();
  const codex = choices.getByRole('radio', { name: 'Codex' });
  await expect(codex).toBeDisabled();
  await expect(engine.getByTestId('engine-codex')).toContainText('Codex is not installed on this computer');
  await expect(choices.getByRole('radio', { name: 'Claude or your own agent (ACP)' })).toBeDisabled();
  await expect(engine.getByRole('button', { name: 'Save engine' })).toBeDisabled();
  // Arrow keys skip what cannot run here.
  await choices.getByRole('radio', { name: 'Pi' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(choices.getByRole('radio', { name: 'Practice' })).toBeFocused();
  await expect(choices.getByRole('radio', { name: 'Practice' })).toBeChecked();
  await shot(page, '03-ai-and-models-engine');

  // A refusal keeps the choice; nothing changes until the person saves again.
  await mode(page, 'refused');
  await engine.getByRole('button', { name: 'Save engine' }).click();
  await expect(engine.getByRole('alert')).toContainText('This controlled test refuses the engine.');
  await expect(choices.getByRole('radio', { name: 'Practice' })).toBeChecked();
  await expect(engine.getByTestId('engine-current')).not.toContainText('Next start');
  // A lost answer is not known: it is never sent again by itself, and the saved state is read back.
  await mode(page, 'lost');
  const reads = (await fixture(page)).reads;
  await engine.getByRole('button', { name: 'Save engine' }).click();
  await expect(engine.getByRole('alert')).toContainText('not confirmed');
  await expect(dialog).not.toContainText('private-transport-error-canary');
  await expect.poll(async () => (await fixture(page)).reads).toBeGreaterThan(reads);
  expect((await fixture(page)).puts).toEqual([{ engine: 'stub' }, { engine: 'stub' }]);
  // Until a read establishes what is saved, Save stays off; a failed check says so and offers Check again.
  await mode(page, 'lost'); await failReads(page, true);
  await engine.getByRole('button', { name: 'Save engine' }).click();
  await expect(engine.getByRole('alert')).toContainText('not confirmed');
  await expect(engine.getByRole('alert')).toContainText('checking the saved engine failed');
  await expect(engine.getByRole('button', { name: 'Save engine' })).toBeDisabled();
  await expect(dialog).not.toContainText('private-read-error-canary');
  expect((await fixture(page)).puts).toHaveLength(3);
  await failReads(page, false);
  const fresh = (await fixture(page)).fresh;
  await engine.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(async () => (await fixture(page)).fresh).toBe(fresh + 1);
  await expect(engine.getByRole('alert')).not.toContainText('checking the saved engine failed');
  await expect(engine.getByRole('button', { name: 'Save engine' })).toBeEnabled();
  expect((await fixture(page)).puts).toHaveLength(3);

  await mode(page, 'allowed');
  await choices.getByRole('radio', { name: 'Practice' }).click();
  await engine.getByRole('button', { name: 'Save engine' }).click();
  await expect(engine.getByRole('status')).toContainText('Practice will run when the app next starts. Quit and reopen the app to apply it.');
  await expect(engine.getByTestId('engine-current')).toContainText('In use now: Pi');
  await expect(engine.getByTestId('engine-current')).toContainText('Next start: Practice');
  expect((await fixture(page)).puts.at(-1)).toEqual({ engine: 'stub' });
  await expect(engine.getByRole('radiogroup', { name: 'Engine' }).getByRole('radio')).toHaveCount(4);

  await dialog.getByText('Change your model', { exact: true }).click();
  await expect(dialog.getByRole('form', { name: 'Your own key', exact: true })).toBeVisible();
  await expect(dialog.getByRole('form', { name: 'Your own key', exact: true }).getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await dialog.getByText('Change your model', { exact: true }).click();
  // Closed again, the page shows engine, your model and shared work with their current values.
  await engine.getByText('Change engine', { exact: true }).click();
  await expect(engine.getByRole('radiogroup', { name: 'Engine' })).toBeHidden();
  await dialog.locator('#settings-section-title').scrollIntoViewIfNeeded();
  await shot(page, '04-ai-and-models');
});

test('under a managed policy only the engines it allows are offered', async ({ page }) => {
  const dialog = await open(page, { policy: true, build: 'development' });
  await section(page, dialog, 'AI and models');
  const engine = dialog.getByRole('region', { name: 'Engine' });
  await engine.getByText('Change engine', { exact: true }).click();
  const choices = engine.getByRole('radiogroup', { name: 'Engine' });
  for (const name of ['Pi', 'Codex', 'Claude or your own agent (ACP)']) await expect(choices.getByRole('radio', { name })).toBeDisabled();
  await expect(choices.getByRole('radio', { name: 'Practice' })).toBeEnabled();
  await expect(engine.getByTestId('engine-pi')).toContainText('managed policy does not allow this engine');
});

test('Settings opens again at the section last used, and People and roles keeps its look', async ({ page }) => {
  const dialog = await open(page);
  await section(page, dialog, 'Backup');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await openSettings(page);
  if (!narrow(page)) await expect(nav(dialog).getByRole('button', { name: 'Backup', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(dialog.locator('#settings-section-title')).toHaveText('Backup');
  await section(page, dialog, 'People and roles');
  await expect(dialog.getByRole('button', { name: 'Create invitation' })).toBeVisible();
  await shot(page, '05-people-and-roles');
  if (narrow(page)) {
    await dialog.getByRole('button', { name: 'All settings' }).click();
    await shot(page, '06-narrow-list');
  }
});

test('a fixed engine at launch is said plainly, and saving does not claim it will run', async ({ page }) => {
  const dialog = await open(page, { build: 'development', environment: true });
  await section(page, dialog, 'AI and models');
  const engine = dialog.getByRole('region', { name: 'Engine' });
  await engine.getByText('Change engine', { exact: true }).click();
  await engine.getByRole('radiogroup', { name: 'Engine' }).getByRole('radio', { name: 'Practice' }).click();
  await engine.getByRole('button', { name: 'Save engine' }).click();
  await expect(engine.getByRole('status')).toContainText('Saved. This computer starts the app with a fixed engine, so Pi runs until that setting is removed.');
  await expect(engine.getByRole('status')).not.toContainText('will run when the app next starts');
  await expect(engine.getByTestId('engine-current')).toContainText('Saved choice: Practice');
  await expect(engine.getByTestId('engine-current')).toContainText('Next start: Pi');
});

test('an installed app offers the practice engine only when it is in use or saved', async ({ page }) => {
  const dialog = await open(page, { build: 'installed' });
  await section(page, dialog, 'AI and models');
  const engine = dialog.getByRole('region', { name: 'Engine' });
  await engine.getByText('Change engine', { exact: true }).click();
  const choices = engine.getByRole('radiogroup', { name: 'Engine' });
  await expect(choices.getByRole('radio')).toHaveCount(3);
  await expect(choices.getByRole('radio', { name: 'Practice' })).toHaveCount(0);
  await page.evaluate(() => { const s = (window as any).settingsFixture; s.engines.stored = 'harness-stub'; s.engines.next = 'harness-stub'; });
  await engine.getByRole('button', { name: 'Check again' }).click();
  await expect(choices.getByRole('radio', { name: 'Practice' })).toBeVisible();
  await expect(choices.getByRole('radio')).toHaveCount(4);
});

test('with no model set up, Settings points at the controls below instead of telling the person to open Settings', async ({ page }) => {
  const dialog = await open(page);
  await page.evaluate(() => { (window as any).settingsFixture.noModel = true; });
  await section(page, dialog, 'AI and models');
  const own = dialog.getByTestId('model-active'), shared = dialog.getByTestId('shared-model-route');
  await expect(own).toContainText('Under Change your model below');
  await expect(shared).toContainText('Under Configure shared work below');
  await expect(dialog).not.toContainText('Open Settings');
  await expect(dialog).not.toContainText('the gear in the sidebar');
  await expect(dialog.getByText('Change your model', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Configure shared work', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText(/conversation/i);
  await shot(page, 'settings-no-model');
});
