// Everyday flows a person can trip over: narrowing the window, leaving a dialog or a tab, a read that
// fails, and a message typed before there is a project. Runs on the browser bridge, with no model.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, stopBridge } from './bridge';
import { api, fixture, openMoreView } from './journey';

const focused = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement)?.getAttribute('aria-label') ?? document.activeElement?.tagName);
const file = (name: string) => ({ name, base64: Buffer.from(`# ${name}\n`).toString('base64'), mediaType: 'text/markdown' });

async function open(page: Page, label: string) {
  const home = freshDataHome(label);
  const bridge = await startBridge(home);
  await page.goto(bridge.url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  return { end: async () => { await stopBridge(bridge.proc); await removeDataHome(home); } };
}
async function project(page: Page) {
  const p = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Launch', kind: 'folder' });
  await api(page, 'material.attach', { projectId: p.value.id, ...file('note.md') });
  await page.getByRole('navigation').getByRole('button', { name: 'Launch' }).click();
  return p.value.id;
}

test('a document stays readable after narrowing from beside the file browser', async ({ page }) => {
  const { end } = await open(page, 'flow-narrow');
  try {
    await project(page);
    await page.setViewportSize({ width: 700, height: 800 });
    await page.getByRole('button', { name: 'Show side pane' }).click();
    await page.keyboard.press('ControlOrMeta+p');
    await page.getByTestId('file-row').filter({ hasText: 'note.md' }).click();
    await expect(page.getByTestId('file-tab').filter({ visible: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close pane' }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.keyboard.press('ControlOrMeta+p');
    await page.getByTestId('file-row').filter({ hasText: 'note.md' }).click();
    await expect.poll(async () => (await page.getByTestId('reader').filter({ visible: true }).boundingBox())?.width ?? 0).toBeGreaterThan(300);
  } finally { await end(); }
});

test('between phone and desktop the open pane is not under the sidebar', async ({ page }) => {
  const { end } = await open(page, 'flow-tablet');
  try {
    await project(page);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.keyboard.press('ControlOrMeta+p');
    await expect(page.getByTestId('pane')).toBeVisible();
    const over = await page.evaluate(() => !!document.elementFromPoint(120, 400)?.closest('[data-testid=pane]'));
    expect(over, 'the pane is on top where it claims to be').toBe(true);
  } finally { await end(); }
});

test('leaving a dialog, a tab or the pane leaves focus somewhere useful', async ({ page }) => {
  const { end } = await open(page, 'flow-focus');
  try {
    await project(page);
    const settings = page.getByRole('button', { name: 'Settings', exact: true });
    await settings.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(settings).toBeFocused();
    await page.keyboard.press('ControlOrMeta+p');
    await page.getByTestId('file-row').filter({ hasText: 'note.md' }).click();
    await page.getByRole('button', { name: 'Close note.md', exact: true }).click();
    await expect.poll(() => focused(page)).not.toBe('BODY');
    await page.getByRole('button', { name: 'Close pane' }).click();
    await expect(page.getByRole('button', { name: 'Show side pane' })).toBeFocused();
  } finally { await end(); }
});

test('Now says so when it cannot read the work, and recovers', async ({ page }) => {
  const { end } = await open(page, 'flow-now-error');
  try {
    await project(page);
    await page.route('**/api', async (route) => route.request().postDataJSON().method === 'work.now' ? route.fulfill({ status: 503, json: { ok: false, reason: 'NOT_AVAILABLE', detail: 'x' } }) : route.continue());
    await openMoreView(page, 'Now');
    await expect(page.getByRole('alert')).toContainText('Could not read');
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('work-now')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { await end(); }
});

test('a message typed before there is a project survives creating one', async ({ page }) => {
  const { end } = await open(page, 'flow-first-message');
  try {
    const message = page.getByRole('textbox', { name: 'Message' });
    await message.fill('Plan the launch');
    // Send no longer asks for a project (it makes the default one and sends); the person who wants
    // their own project first uses the New project button, and the typed words must follow them.
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Launch');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: /What should we work on in Launch/ })).toBeVisible();
    await expect(message).toHaveValue('Plan the launch');
  } finally { await end(); }
});

async function attached(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add files…' }).click();
  await (await chooser).setFiles(fixture('note.md'));
  await expect(page.getByTestId('attachment-chip')).toHaveCount(1);
}

test('a person withdraws an original with honest words, the refused send keeps their message, and they can restore it', async ({ page }) => {
  const { end } = await open(page, 'flow-withdraw');
  try {
    const projectId = (await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Launch', kind: 'folder' })).value.id;
    await page.getByRole('navigation').getByRole('button', { name: 'Launch' }).click();
    await attached(page);
    await page.getByRole('textbox', { name: 'Message' }).fill('Use this note');
    await page.keyboard.press('ControlOrMeta+p');
    await page.getByTestId('file-row').filter({ hasText: 'note.md' }).click();
    await page.getByRole('button', { name: 'Document options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Withdraw from later work…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Withdraw note.md?' });
    await expect(dialog).toContainText('nothing is purged');
    await dialog.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await expect(page.getByTestId('withdrawn-banner')).toContainText('Withdrawn');
    await expect(page.getByTestId('withdrawn-banner')).toContainText('nothing is purged');
    await expect(page.getByTestId('reader').filter({ visible: true }), 'the person can still read it').toContainText('note');
    await page.getByRole('tab', { name: /Files/ }).first().click();
    await expect(page.getByTestId('file-row').filter({ hasText: 'note.md' }), 'the open tree hears of it').toHaveCount(0);

    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'withdrawn' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' }), 'a refused send keeps the words').toHaveValue('Use this note');
    expect((await api<unknown[]>(page, 'threads.list', {})).length, 'nothing was sent').toBe(0);

    await openMoreView(page, 'Now');
    const row = page.getByTestId('now-withdrawn').filter({ hasText: 'note.md' });
    await expect(row).toBeVisible();
    await expect(page.getByTestId('now-retired')).toHaveCount(0);
    await row.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByTestId('now-withdrawn')).toHaveCount(0);
    expect((await api<{ withdrawn: unknown[] }>(page, 'work.now', { projectId })).withdrawn).toEqual([]);
  } finally { await end(); }
});

test('Withdraw is offered only for an original', async ({ page }) => {
  const { end } = await open(page, 'flow-withdraw-only');
  try {
    const projectId = await project(page);
    const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId, text: 'Write an editable brief', attachments: [], settings: { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'brief' });
    expect(sent.value.threadId).toBeTruthy();
    await expect.poll(async () => (await api<{ name: string }[]>(page, 'material.list', { projectId })).map((m) => m.name)).toContain('brief.md');
    await page.keyboard.press('ControlOrMeta+p');
    await page.getByTestId('file-row').filter({ hasText: 'note.md' }).click();
    await page.getByRole('button', { name: 'Document options', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Withdraw from later work…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: /Files/ }).first().click();
    await page.getByTestId('file-row').filter({ hasText: 'brief.md' }).click();
    await page.getByRole('button', { name: 'Document options', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Download' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Withdraw from later work…' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally { await end(); }
});

test('a withheld answer says it is not carried forward', async ({ page }) => {
  const { end } = await open(page, 'flow-withheld');
  try {
    const projectId = await project(page);
    const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId, text: 'Hello', attachments: [], settings: { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'held' });
    await page.route('**/api', async (route) => {
      if (route.request().postDataJSON().method !== 'threads.get') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.value.turns.at(-1).withheld = true;
      return route.fulfill({ response, json: body });
    });
    await page.getByRole('navigation').getByRole('button', { name: 'Hello' }).first().click();
    await expect(page.getByTestId('turn-withheld')).toContainText('not carried');
    expect(sent.value.threadId).toBeTruthy();
  } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await end(); }
});

test('after the first message the caret stays ready for the next', async ({ page }) => {
  const { end } = await open(page, 'flow-caret');
  try {
    await project(page);
    const message = page.getByRole('textbox', { name: 'Message' });
    await message.fill('Hello');
    await message.press('Enter');
    await expect(page.getByTestId('turn')).toHaveCount(1);
    await expect(message).toBeFocused();
  } finally { await end(); }
});

test('the narrow sidebar takes focus, closes with Escape and gives focus back', async ({ page }) => {
  const { end } = await open(page, 'flow-sidebar');
  try {
    await project(page);
    await page.setViewportSize({ width: 375, height: 812 });
    const opener = page.getByRole('button', { name: 'Open sidebar' });
    await opener.click();
    await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeHidden();
    await expect(opener).toBeFocused();
  } finally { await end(); }
});

test('a folder conflict is shown, waits for a restore while withdrawn, and the person keeps it', async ({ page }) => {
  const { end } = await open(page, 'flow-unsure');
  try {
    const projectId = await project(page);
    type Entry = { id: string; current: number; lifecycle?: number };
    const entry = async () => (await api<Entry[]>(page, 'material.list', { projectId, includeHidden: true }))[0];
    const set = async (state: string) => { const e = await entry(); return api<{ ok: boolean; detail?: string }>(page, 'material.lifecycle', { id: e.id, version: e.current, state, lifecycle: e.lifecycle ?? 0 }); };
    expect(await set('withdrawn')).toMatchObject({ ok: true });
    await api(page, 'terminal.run', { projectId, command: "printf 'a new file of theirs\n' > note.md" });
    expect(await set('current')).toMatchObject({ ok: true });
    await openMoreView(page, 'Now');
    const row = page.getByTestId('now-needs-you').filter({ hasText: 'note.md' });
    await expect(row).toContainText('A different file is at this path');
    await expect(row.getByRole('button', { name: 'Keep it' })).toBeVisible();

    expect(await set('withdrawn')).toMatchObject({ ok: true });
    await page.reload();
    await expect(page.getByTestId('now-withdrawn')).toBeVisible();
    await expect(row).toContainText('Restore it first');
    await expect(row.getByRole('button', { name: 'Keep it' })).toHaveCount(0);
    await page.getByTestId('now-withdrawn').getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByTestId('now-withdrawn')).toHaveCount(0);
    await row.getByRole('button', { name: 'Keep it' }).click();
    await expect(row).toHaveCount(0);
  } finally { await end(); }
});

test('a choice made just before a reload is still there after it', async ({ page }) => {
  const { end } = await open(page, 'flow-reload');
  try {
    await project(page);
    await openMoreView(page, 'Now');
    await expect(page.getByTestId('work-now')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await expect(page.getByTestId('work-now')).toBeVisible();
  } finally { await end(); }
});

test('words typed just before a reload are still in the composer after it', async ({ page }) => {
  const { end } = await open(page, 'flow-reload-draft');
  try {
    await project(page);
    await page.locator('textarea').first().fill('words typed just now');
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await expect(page.locator('textarea').first()).toHaveValue('words typed just now');
  } finally { await end(); }
});

test('a send\'s key is saved before the send leaves, so a reload cannot lose it', async ({ page }) => {
  const { end } = await open(page, 'flow-send-key');
  try {
    await project(page);
    const seen: { method: string; key?: string }[] = [];
    await page.route('**/api', async (route) => {
      const { method, args } = route.request().postDataJSON();
      if (method === 'drafts.put') seen.push({ method, key: args.meta?.sendKey });
      if (method !== 'turns.send') return route.continue();
      seen.push({ method, key: args.clientKey });
      return route.abort();
    });
    await page.locator('textarea').first().fill('send this once');
    await page.keyboard.press('Enter');
    await expect.poll(() => seen.some((s) => s.method === 'turns.send')).toBe(true);
    const sent = seen.findIndex((s) => s.method === 'turns.send');
    expect(seen.slice(0, sent).map((s) => s.key)).toContain(seen[sent].key);
  } finally { await end(); }
});
