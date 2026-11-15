// Right-click menus on sidebar rows and help on icon-only controls, on the real renderer with a scripted api.
// The context menu and the "more" menu come from one list of items, so the test compares them.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PREFS } from '@backbone-next/platform';
import { repoRoot } from './journey';

let server: ViteDevServer, url: string;
test.setTimeout(45_000);
test.beforeAll(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function open(page: Page, remote = false) {
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  await page.addInitScript(([prefs, remote]) => {
    const now = '2026-11-14T09:00:00Z';
    const thread = (id: string, title: string, extra = {}) => ({ id, projectId: 'project', title, pinned: false, unread: false, archived: false, running: false, updatedAt: now, ...extra });
    const state = { threads: [thread('t1', 'Quarterly plan'), thread('t2', 'Pinned notes', { pinned: true })], updates: [] as unknown[], listeners: [] as ((e: unknown) => void)[] };
    Object.assign(window, { sidebarFixture: state, backbone: {
      platform: 'linux', setTheme() {},
      onEvent(listener: (e: unknown) => void) { state.listeners.push(listener); return () => {}; },
      async identityConfiguration() { return { company: false, signedIn: true, remote: remote ? { origin: 'https://colleague.example', connection: 'online' } : undefined }; },
      async call(method: string, args: any) {
        if (method === 'host.status') return { owns: true };
        if (method === 'identity.get') { const owner = { id: 'owner', name: 'Workspace owner', role: 'owner', status: 'active' }; return { ok: true, value: { person: owner, people: [owner], deviceOwner: true } }; }
        if (method === 'viewer.get') return { ...prefs, selectedProjectId: 'project', pane: { open: false, tabs: [] } };
        if (method === 'viewer.put') return args.prefs;
        if (method === 'projects.list') return [{ id: 'project', name: 'Harbor', kind: 'folder', createdAt: now }];
        if (method === 'threads.list') return structuredClone(state.threads);
        if (method === 'threads.update') {
          state.updates.push(args);
          state.threads = state.threads.map((t) => (t.id === args.id ? { ...t, ...args.patch } : t));
          setTimeout(() => state.listeners.forEach((l) => l({ topic: 'threads' })));
          return { ok: true, value: {} };
        }
        if (['models.list', 'plugins.parts', 'material.list', 'files.list'].includes(method)) return [];
        if (method === 'work.now') return { needsYou: [], running: [], progress: [], current: [], temporary: [], withdrawn: [], retired: [] };
        if (method === 'drafts.get') return null;
        return null;
      },
    } });
  }, [DEFAULT_PREFS, remote] as const);
  await page.goto(url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
}

// Reach a control as a keyboard user does, so it takes focus-visible focus.
async function tabTo(page: Page, target: Locator) {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < 60 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}
const wide = (page: Page) => (page.viewportSize()?.width ?? 1440) >= 768;
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Projects and threads' });
const labels = async (menu: Locator) => (await menu.getByRole('menuitem').allTextContents()).map((t) => t.trim());
const shotDir = join(repoRoot, 'evidence', 'fable-delivery-20261113', 'ui', 'sidebar');
const shot = async (page: Page, name: string, info: { project: { name: string } }) => {
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, `${process.env.SIDEBAR_SHOT_PREFIX ?? ''}${info.project.name.replace('browser-', '')}-${name}.png`) });
};

// With no menu open: the sidebar as it renders, so a run on the base commit (SIDEBAR_SHOT_PREFIX=base-) can be put beside it.
test('the sidebar with no menu open, for comparison with the base', async ({ page }, info) => {
  await open(page);
  if (!wide(page)) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Quarterly plan', exact: true })).toBeVisible();
  await page.mouse.move(1000, 500);
  await shot(page, 'sidebar-plain', info);
});

test('a right-click on a conversation opens the same menu as its more button', async ({ page }, info) => {
  if (!wide(page)) return; // the narrow window opens the sidebar over the page; the wide runs prove the menus
  await open(page);
  const row = sidebar(page).getByRole('button', { name: 'Quarterly plan', exact: true });
  await sidebar(page).getByRole('button', { name: 'Thread actions for Quarterly plan' }).click({ force: true });
  const more = page.getByRole('menu');
  await expect(more.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  const fromButton = await labels(more);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  await row.click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  expect(await labels(menu)).toEqual(fromButton);
  expect(fromButton).toEqual(['Rename', 'Pin', 'Mark as unread', 'Schedule…', 'Project', 'Section', 'Fork', 'Archive', 'Delete permanently']);
  await shot(page, 'context-menu-conversation', info);

  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const name = sidebar(page).getByRole('textbox', { name: 'Thread name' });
  await expect(name).toBeFocused();
  await name.fill('Annual plan');
  await name.press('Enter');
  await expect(sidebar(page).getByRole('button', { name: 'Annual plan', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).sidebarFixture.updates)).toEqual([{ id: 't1', patch: { title: 'Annual plan' } }]);
});

test('a pinned item has the menu too, and a text field keeps the system menu', async ({ page }) => {
  if (!wide(page)) return; // the narrow window opens the sidebar over the page; the wide runs prove the menus
  await open(page);
  await sidebar(page).getByRole('button', { name: 'Pinned notes', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Unpin' })).toBeVisible();
  await page.keyboard.press('Escape');
  await sidebar(page).getByRole('button', { name: 'Quarterly plan', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const name = sidebar(page).getByRole('textbox', { name: 'Thread name' });
  const prevented = await name.evaluate((el) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('Shift+F10 opens the menu on the focused conversation and Escape returns focus to it', async ({ page }) => {
  if (!wide(page)) return; // the narrow window opens the sidebar over the page; the wide runs prove the menus
  await open(page);
  const row = sidebar(page).getByRole('button', { name: 'Quarterly plan', exact: true });
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(row).toBeFocused();
});

test('a right-click on empty sidebar space offers New chat and New project', async ({ page }, info) => {
  if (!wide(page)) return; // the narrow window opens the sidebar over the page; the wide runs prove the menus
  await open(page);
  await sidebar(page).getByRole('button', { name: 'Harbor', exact: true }).click({ button: 'right' });
  expect(await labels(page.getByRole('menu'))).toEqual(['New chat', 'New project']);
  await shot(page, 'context-menu-project', info);
  await page.getByRole('menuitem', { name: 'New project' }).click();
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  // The app's word for a conversation a person starts is "chat".
  await expect(page.getByRole('dialog', { name: 'New project' })).toHaveAccessibleDescription('A project holds chats and their files.');
});

test('the joined view has no row menu', async ({ page }) => {
  if (!wide(page)) return; // the narrow window opens the sidebar over the page; the wide runs prove the menus
  await open(page, true);
  await expect(sidebar(page).getByRole('button', { name: /Thread actions for/ })).toHaveCount(0);
  await sidebar(page).getByRole('button', { name: 'Quarterly plan', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'New project' })).toHaveCount(0);
});

test('icon-only controls show their name on hover and on keyboard focus, including the collapsed rail', async ({ page }, info) => {
  if (!wide(page)) return; // the narrow window opens the sidebar over the page; the wide runs prove the menus
  await open(page);
  const search = sidebar(page).getByRole('button', { name: 'Search chats' });
  await expect(search).not.toHaveAttribute('title', /.+/);
  await tabTo(page, search);
  await expect(page.getByRole('tooltip')).toHaveText('Search chats');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  await sidebar(page).getByRole('button', { name: 'Collapse sidebar' }).click();
  const rail = page.getByRole('button', { name: 'Expand sidebar' });
  await tabTo(page, rail);
  await expect(page.getByRole('tooltip')).toHaveText('Expand sidebar');
  await shot(page, 'rail-tooltip', info);
  // Hover: nothing at first, the help after a short delay; leaving closes it.
  await rail.blur();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await rail.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Expand sidebar');
  await page.mouse.move(700, 400, { steps: 8 });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await tabTo(page, page.getByRole('button', { name: 'Hide side pane' }).or(page.getByRole('button', { name: 'Show side pane' })));
  await expect(page.getByRole('tooltip')).toHaveText(/side pane/);
});
