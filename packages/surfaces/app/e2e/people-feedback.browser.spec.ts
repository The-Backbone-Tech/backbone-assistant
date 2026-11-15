// Actual Settings controls and renderer; synthetic receipts exercise response loss without a DB or accounts.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFS } from '@backbone-next/platform';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

let server: ViteDevServer, url: string;
test.setTimeout(30_000);
test.beforeAll(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function open(page: Page) {
  await page.addInitScript(prefs => {
    const owner = { id: 'owner', name: 'Workspace owner', role: 'owner', status: 'active' };
    const colleague = { id: 'colleague', name: 'Colleague', role: 'member', status: 'active' };
    const items = [{ id: 'helper', name: 'Existing helper', person: colleague.id, project: 'project', mandate: 'mandate', piece: null, revoked: false }];
    const state = { mode: 'refused', grants: [{ person: 'colleague', access: 'viewer' }] as { person: string; access: string }[], shares: [] as unknown[], calls: [] as string[], reads: 0, release: undefined as (() => void) | undefined };
    Object.assign(window, { peopleFixture: state, backbone: {
      platform: 'linux', setTheme() {}, onEvent() { return () => {}; },
      async call(method: string, args: any) {
        if (method === 'host.status') return { owns: true };
        if (method === 'identity.get') { state.reads++; return { ok: true, value: structuredClone({ person: owner, people: [owner, colleague], deviceOwner: true }) }; }
        if (method === 'identity.automations') { state.reads++; return { ok: true, value: structuredClone(items) }; }
        if (method === 'settings.policy.get') return { state: 'none' };
        if (method === 'viewer.get') return { ...prefs, selectedProjectId: 'project', pane: { open: false, tabs: [] } };
        if (method === 'viewer.put') return args.prefs;
        if (method === 'projects.list') return [{ id: 'project', name: 'Shared project', kind: 'folder', createdAt: '2026-11-14T09:00:00Z' }];
        if (['threads.list', 'models.list', 'plugins.parts', 'material.list', 'files.list'].includes(method)) return [];
        if (method === 'work.now') return { needsYou: [], running: [], progress: [], current: [], temporary: [], withdrawn: [], retired: [] };
        if (method === 'drafts.get') return null;
        if (method === 'settings.model.get') return { harness: 'harness-stub' };
        if (method === 'identity.sharing') return { ok: true, value: structuredClone({ access: 'owner', nativeAccountTools: false, people: [owner, colleague], grants: state.grants }) };
        if (method === 'identity.share') {
          state.calls.push(method); state.shares.push(args.access);
          state.grants = args.access ? [{ person: args.personId, access: args.access }] : [];
          return { ok: true, value: { changed: true } };
        }
        if (['identity.role', 'identity.remove', 'identity.invite', 'identity.automation.create', 'identity.automation.revoke', 'identity.automation.run'].includes(method)) {
          state.calls.push(method);
          const mode = state.mode;
          if (mode === 'pending') await new Promise<void>(resolve => { state.release = resolve; });
          if (mode === 'refused') return { ok: false, outcome: 'REFUSED', reason: 'INVALID', detail: 'An owner must keep access to this workspace.' };
          if (mode === 'unknown') return { ok: false, outcome: 'UNKNOWN', reason: 'NOT_AVAILABLE', detail: 'The response could not be confirmed.' };
          // A lost response may follow a real mutation. The next read reveals its state, not a success receipt.
          if (method === 'identity.role') colleague.role = args.role;
          if (method === 'identity.remove') colleague.status = 'removed';
          if (method === 'identity.automation.create') items.push({ ...items[0], id: 'created', name: args.name });
          if (method === 'identity.automation.revoke') items[0].revoked = true;
          if (mode === 'lost' || mode === 'pending') throw new Error('private-transport-error-canary');
          return { ok: true, value: method === 'identity.invite' ? { token: 'confirmed-invitation', expiresAt: '2026-11-15T09:00:00Z' } : { changed: true, removed: true, revoked: true, id: 'created', threadId: 'thread', turnId: 'turn' } };
        }
        return null;
      },
    } });
  }, DEFAULT_PREFS);
  await page.goto(url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  // A narrow window keeps the sidebar closed until it is opened.
  if ((page.viewportSize()?.width ?? 1440) < 768) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'People and roles', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Role for Colleague' })).toHaveValue('member');
  return dialog;
}

type Action = 'role' | 'remove' | 'create' | 'revoke' | 'run' | 'invite';
async function prepare(dialog: Locator, action: Action) {
  if (action === 'create') {
    await dialog.getByRole('textbox', { name: 'Automation name', exact: true }).fill('Weekly helper');
    await dialog.getByRole('combobox', { name: 'Acts for' }).selectOption('colleague');
    await dialog.getByRole('combobox', { name: 'Automation project' }).selectOption('project');
  }
  if (action === 'run') await dialog.getByRole('textbox', { name: 'Automation task' }).fill('Review the weekly plan');
}
async function act(dialog: Locator, action: Action) {
  if (action === 'role') return dialog.getByRole('combobox', { name: 'Role for Colleague' }).selectOption('admin');
  const names = { remove: 'Remove Colleague', create: 'Create automation', revoke: 'Revoke Existing helper', run: 'Run Existing helper', invite: 'Create invitation' };
  await dialog.getByRole('button', { name: names[action], exact: true }).click();
  // Removing a person and revoking a helper ask once; the confirmation is the act.
  if (action === 'remove' || action === 'revoke') await dialog.page().getByRole('dialog', { name: action === 'remove' ? 'Remove Colleague?' : 'Revoke Existing helper?' }).getByRole('button', { name: names[action], exact: true }).click();
}
const calls = (page: Page) => page.evaluate(() => (window as any).peopleFixture.calls as string[]);
const mode = (page: Page, value: string) => page.evaluate(value => { (window as any).peopleFixture.mode = value; }, value);

for (const action of ['role', 'remove', 'create', 'revoke', 'run', 'invite'] as const) {
  test(`${action} shows a confirmed refusal, keeps state and allows a later intentional action`, async ({ page }) => {
    const dialog = await open(page);
    await prepare(dialog, action);
    await act(dialog, action);
    await expect(dialog.getByRole('alert')).toContainText('refused', { timeout: 5_000 });
    await expect(dialog.getByRole('alert')).toContainText('An owner must keep access to this workspace.');
    await expect(dialog.getByRole('combobox', { name: 'Role for Colleague' })).toHaveValue('member');
    await expect(dialog.getByRole('button', { name: 'Remove Colleague' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Revoke Existing helper' })).toBeEnabled();
    if (action === 'create') await expect(dialog.getByRole('textbox', { name: 'Automation name', exact: true })).toHaveValue('Weekly helper');
    if (action === 'run') await expect(dialog.getByRole('textbox', { name: 'Automation task' })).toHaveValue('Review the weekly plan');
    expect(await calls(page)).toHaveLength(1);
    await mode(page, 'allowed');
    await act(dialog, action);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(await calls(page)).toHaveLength(2);
    if (action === 'role') await expect(dialog.getByRole('combobox', { name: 'Role for Colleague' })).toHaveValue('admin');
    if (action === 'remove') await expect(dialog.getByRole('button', { name: 'Remove Colleague' })).toBeDisabled();
    if (action === 'create') await expect(dialog.getByRole('button', { name: 'Revoke Weekly helper' })).toBeVisible();
    if (action === 'revoke') await expect(dialog.getByRole('button', { name: 'Revoke Existing helper' })).toBeDisabled();
    if (action === 'invite') await expect(dialog.getByRole('textbox', { name: 'Invitation code' })).toHaveValue('confirmed-invitation');
  });
}

for (const result of ['unknown', 'lost'] as const) test(`${result} response is unconfirmed, refreshes current state and never repeats a mutation`, async ({ page }) => {
  const dialog = await open(page);
  await prepare(dialog, 'create');
  const reads = await page.evaluate(() => (window as any).peopleFixture.reads as number);
  await mode(page, result);
  await act(dialog, 'create');
  await expect(dialog.getByRole('alert')).toContainText('not confirmed', { timeout: 5_000 });
  await expect(dialog.getByRole('alert')).toContainText('Inspect');
  await expect(dialog.getByRole('alert')).not.toContainText('refused');
  await expect(dialog).not.toContainText('private-transport-error-canary');
  await expect(dialog.getByRole('textbox', { name: 'Automation name', exact: true })).toHaveValue('Weekly helper');
  await expect.poll(() => page.evaluate(() => (window as any).peopleFixture.reads as number)).toBeGreaterThan(reads);
  if (result === 'lost') await expect(dialog.getByRole('button', { name: 'Revoke Weekly helper' })).toBeVisible();
  expect(await calls(page)).toHaveLength(1);
  await mode(page, 'allowed');
  // A deliberate different action is still available; refreshing never dispatched another create.
  await dialog.getByRole('button', { name: 'Revoke Existing helper' }).click();
  await dialog.page().getByRole('dialog', { name: 'Revoke Existing helper?' }).getByRole('button', { name: 'Revoke Existing helper', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Revoke Existing helper' })).toBeDisabled();
  expect(await calls(page)).toEqual(['identity.automation.create', 'identity.automation.revoke']);
});

test('a pending control dispatches once and failed invitation replacement keeps its confirmed code', async ({ page }) => {
  const dialog = await open(page);
  await mode(page, 'allowed'); await act(dialog, 'invite');
  await expect(dialog.getByRole('textbox', { name: 'Invitation code' })).toHaveValue('confirmed-invitation');
  await mode(page, 'pending');
  const button = dialog.getByRole('button', { name: 'Create invitation', exact: true });
  await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(button).toBeDisabled();
  expect(await calls(page)).toEqual(['identity.invite', 'identity.invite']);
  await page.evaluate(() => (window as any).peopleFixture.release());
  await expect(dialog.getByRole('alert')).toContainText('not confirmed');
  await expect(button).toBeEnabled();
  await expect(dialog.getByRole('textbox', { name: 'Invitation code' })).toHaveValue('confirmed-invitation');
  expect(await calls(page)).toHaveLength(2);
});

async function shot(page: Page, name: string) {
  const folder = process.env.BACKBONE_LOWS_SHOTS; if (!folder) return;
  mkdirSync(folder, { recursive: true }); await page.mouse.move(1, 1);
  await page.screenshot({ animations: 'disabled', path: join(folder, `${test.info().project.name.replace(/^browser-/, '')}-${name}.png`) });
}
test('removing a person and revoking a helper look destructive; creating and running do not', async ({ page }) => {
  const dialog = await open(page);
  const colours = (name: string) => dialog.getByRole('button', { name, exact: true }).evaluate(element => {
    const probe = document.createElement('span'); probe.style.color = 'var(--danger)'; document.body.append(probe);
    const danger = getComputedStyle(probe).color; probe.remove();
    const style = getComputedStyle(element);
    return { danger, text: style.color, border: style.borderTopColor };
  });
  for (const name of ['Remove Colleague', 'Revoke Existing helper']) {
    const c = await colours(name);
    expect(c.text, name).toBe(c.danger); expect(c.border, name).toBe(c.danger);
  }
  for (const name of ['Create invitation', 'Create automation', 'Run Existing helper']) {
    const c = await colours(name); expect(c.text, name).not.toBe(c.danger);
  }
  await shot(page, 'people-danger-buttons');
});

const confirmDialog = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name });
test('one click on Remove asks first and removes nothing; Cancel and Escape keep the person and return focus', async ({ page }) => {
  const dialog = await open(page); await mode(page, 'allowed');
  const remove = dialog.getByRole('button', { name: 'Remove Colleague', exact: true });
  const ask = confirmDialog(page, 'Remove Colleague?');
  await remove.click();
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('loses access to this workspace now');
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await shot(page, 'confirm-remove-person');
  expect(await calls(page)).toEqual([]);
  await page.keyboard.press('Tab'); await expect(ask.getByRole('button', { name: 'Remove Colleague', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(ask).toHaveCount(0); await expect(remove).toBeFocused();
  await remove.click(); await expect(ask).toBeVisible(); await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0); await expect(remove).toBeFocused();
  expect(await calls(page)).toEqual([]); await expect(remove).toBeEnabled();
});
test('confirming Remove removes once, a pending confirm cannot be sent twice, and focus lands on the surviving row', async ({ page }) => {
  const dialog = await open(page); await mode(page, 'pending');
  await dialog.getByRole('button', { name: 'Remove Colleague', exact: true }).click();
  const ask = confirmDialog(page, 'Remove Colleague?');
  const go = ask.getByRole('button', { name: 'Remove Colleague', exact: true });
  await go.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(ask.getByRole('button', { name: 'Working…' })).toBeDisabled();
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await shot(page, 'confirm-remove-pending');
  await page.keyboard.press('Escape'); await expect(ask).toBeVisible();
  expect(await calls(page)).toEqual(['identity.remove']);
  await mode(page, 'allowed'); await page.evaluate(() => (window as any).peopleFixture.release());
  // The answer was lost: the dialog closes, the page says it is not known and shows the current state.
  await expect(ask).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toContainText('not confirmed');
  await expect(dialog.getByRole('button', { name: 'Remove Colleague', exact: true })).toBeDisabled();
  await expect(page.locator('#person-colleague')).toBeFocused();
  expect(await calls(page)).toEqual(['identity.remove']);
});
test('a confirmed Remove sends one request and shows the person as removed', async ({ page }) => {
  const dialog = await open(page); await mode(page, 'allowed');
  await dialog.getByRole('button', { name: 'Remove Colleague', exact: true }).click();
  await confirmDialog(page, 'Remove Colleague?').getByRole('button', { name: 'Remove Colleague', exact: true }).click();
  await expect(dialog.getByText('Colleague · Removed')).toBeVisible();
  expect(await calls(page)).toEqual(['identity.remove']);
  await expect(page.locator('#person-colleague')).toBeFocused();
});
test('Revoke asks first; Cancel revokes nothing', async ({ page }) => {
  const dialog = await open(page); await mode(page, 'allowed');
  const revoke = dialog.getByRole('button', { name: 'Revoke Existing helper', exact: true });
  await revoke.click();
  const ask = confirmDialog(page, 'Revoke Existing helper?');
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(ask).toContainText('stops its running work now');
  await shot(page, 'confirm-revoke-helper');
  await page.keyboard.press('Escape'); await expect(ask).toHaveCount(0); await expect(revoke).toBeFocused();
  expect(await calls(page)).toEqual([]);
});

test('saving sharing asks only when it removes access', async ({ page }) => {
  const dialog = await open(page); await mode(page, 'allowed');
  if ((page.viewportSize()?.width ?? 1440) < 768) await dialog.getByRole('button', { name: 'All settings' }).click();
  await dialog.getByRole('button', { name: 'Sharing', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Shared project' }).selectOption('project');
  const who = dialog.getByRole('combobox', { name: 'Share with' });
  await who.selectOption('colleague');
  const save = dialog.getByRole('button', { name: 'Save sharing', exact: true });
  // Keeping or adding access asks nothing.
  await dialog.getByRole('combobox', { name: 'Project permission' }).selectOption('editor');
  await save.click();
  await expect(dialog.getByText('Project sharing saved.')).toBeVisible();
  expect(await calls(page)).toEqual(['identity.share']);
  expect(await page.evaluate(() => (window as any).peopleFixture.shares)).toEqual(['editor']);
  await who.selectOption('colleague');
  await dialog.getByRole('combobox', { name: 'Project permission' }).selectOption('remove');
  await save.click();
  await expect(confirmDialog(page, /Remove Colleague.s access\?/)).toBeVisible();
  await expect(page.getByRole('dialog', { name: /access\?/ }).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await shot(page, 'confirm-remove-access');
  expect(await calls(page)).toEqual(['identity.share']);
  await page.keyboard.press('Escape');
  await expect(save).toBeFocused();
  expect(await calls(page)).toEqual(['identity.share']);
  await save.click();
  await page.getByRole('dialog', { name: /access\?/ }).getByRole('button', { name: /^Remove Colleague.s access$/ }).click();
  await expect.poll(() => calls(page)).toEqual(['identity.share', 'identity.share']);
  expect(await page.evaluate(() => (window as any).peopleFixture.shares)).toEqual(['editor', null]);
});
