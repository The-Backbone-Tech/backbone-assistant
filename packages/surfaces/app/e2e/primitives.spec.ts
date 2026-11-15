// The shared controls, measured: what one screen gets from a primitive, every screen gets.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, stopBridge } from './bridge';
import { api } from './journey';

async function open(page: Page, label: string) {
  const home = freshDataHome(label);
  const bridge = await startBridge(home);
  await page.goto(bridge.url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  const p = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Launch', kind: 'git' });
  await api(page, 'material.attach', { projectId: p.value.id, name: 'note.md', base64: Buffer.from('# Note\n').toString('base64'), mediaType: 'text/markdown' });
  await page.getByRole('navigation').getByRole('button', { name: 'Launch', exact: true }).click();
  return { end: async () => { await stopBridge(bridge.proc); await removeDataHome(home); } };
}
const send = (page: Page, text: string) => { const m = page.getByRole('textbox', { name: 'Message' }); return m.fill(text).then(() => m.press('Enter')); };
const ring = (page: Page) => page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
const style = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p as string), prop);

test('every text field shows where the keyboard is, at one height', async ({ page }) => {
  const { end } = await open(page, 'prim-fields');
  try {
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Name' }).focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect.poll(() => ring(page), { message: 'New project name', intervals: [50] }).not.toBe('none');
    expect((await page.getByRole('textbox', { name: 'Name' }).boundingBox())!.height).toBe(32);
    await page.keyboard.press('Escape');
    await send(page, 'Hello');
    await page.keyboard.press(process.platform === 'darwin' ? 'Alt+Meta+S' : 'Control+Alt+S');
    const side = page.getByRole('textbox', { name: 'Ask the side chat' });
    await side.focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect.poll(() => ring(page), { message: 'Side chat', intervals: [50] }).not.toBe('none');
    expect((await side.boundingBox())!.height).toBe(32);
  } finally { await end(); }
});

test('a select is one control everywhere', async ({ page }) => {
  const { end } = await open(page, 'prim-select');
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    // Language is shown as text since it has one value; the permission choice is a select every data folder has.
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Tool permissions', exact: true }).click();
    const select = page.getByRole('combobox', { name: 'How much runs without asking' });
    await expect(select).toBeVisible();
    expect((await select.boundingBox())!.height).toBe(32);
    expect(await select.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe('6px');
  } finally { await end(); }
});

test('a menu stays inside a narrow window', async ({ page }) => {
  const { end } = await open(page, 'prim-menu');
  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.getByRole('button', { name: /^Model and effort:/ }).click();
    const box = (await page.getByRole('menu').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(312);
  } finally { await end(); }
});

test('both kinds of tab show close on the active one', async ({ page }) => {
  const { end } = await open(page, 'prim-tabs');
  try {
    await send(page, 'First');
    await expect(page.getByTestId('turn')).toHaveCount(1);
    await page.getByRole('button', { name: 'New chat' }).click();
    // The new-chat view must be up before typing, or "Second" lands in the first conversation.
    await expect(page.getByRole('heading', { name: /What should we work on in Launch/ })).toBeVisible();
    await send(page, 'Second');
    await expect(page.getByRole('tablist', { name: 'Open conversations' })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Open conversations' }).getByRole('tab');
    const seen = async () => JSON.stringify({ tabs: await tabs.evaluateAll((all) => all.map((t) => [t.textContent, t.getAttribute('aria-selected')])), composer: await page.getByRole('textbox', { name: 'Message' }).inputValue().catch(() => 'no composer'), turns: await page.getByTestId('turn').allTextContents(), alerts: await page.getByRole('alert').allTextContents() });
    // The second conversation is open and selected before its close control is measured; if not, say what was there.
    const reached = async (check: () => Promise<void>) => { try { await check(); } catch (error) { throw new Error(`${(error as Error).message}\nSeen: ${await seen()}`); } };
    await reached(() => expect(page.getByRole('tab', { name: /Second/ })).toHaveAttribute('aria-selected', 'true'));
    await reached(() => expect(page.getByTestId('turn').first()).toContainText('Second'));
    const close = page.getByRole('button', { name: /^Close conversation view Second/ });
    await page.mouse.move(0, 0);
    await reached(() => expect.poll(() => close.evaluate((e) => getComputedStyle(e).opacity)).toBe('1'));
    const tab = page.getByRole('tab', { name: /Second/ });
    expect(await tab.evaluate((e) => getComputedStyle(e).fontSize), 'the interface size token wins').toBe('13px');
  } finally { await end(); }
});

test('typing straight after New chat lands in the message box', async ({ page }) => {
  const { end } = await open(page, 'prim-new-chat');
  try {
    await send(page, 'First');
    await expect(page.getByTestId('turn')).toHaveCount(1);
    // A click leaves the keyboard on the button that was clicked. New chat is a request to write, so the message box takes it.
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByRole('heading', { name: /What should we work on in Launch/ })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
    await page.keyboard.type('Second');
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Second');
    // The same from the new-chat view itself, where nothing is mounted again.
    await page.getByRole('button', { name: 'Search chats' }).focus();
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('turn').first()).toContainText('Second');
  } finally { await end(); }
});

test('help stays out of the way when the app puts the keyboard in a text field', async ({ page }) => {
  const { end } = await open(page, 'prim-field-help');
  try {
    // Opening Browser focuses its address. A browser treats any focused text field as keyboard focus, so the
    // field's help used to open by itself, over the tab row above it.
    await page.keyboard.press('ControlOrMeta+Shift+b');
    const address = page.getByRole('textbox', { name: 'Page address' });
    await expect(address).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await address.hover();
    await expect(page.getByRole('tooltip')).toContainText('Page address');
  } finally { await end(); }
});

test('the new-chat question keeps its question mark beside the project name', async ({ page }) => {
  const { end } = await open(page, 'prim-question');
  try {
    await page.keyboard.press('ControlOrMeta+p'); // The pane narrows the middle region.
    const heading = page.getByRole('heading', { name: /What should we work on in Launch/ });
    await expect(heading).toBeVisible();
    const tops = await heading.evaluate((h) => {
      const mark = [...h.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.includes('?')) ?? [...h.querySelectorAll('*')].flatMap((e) => [...e.childNodes]).reverse().find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.includes('?'))!;
      const range = document.createRange(); range.selectNodeContents(mark);
      const name = h.querySelector('button')!.getBoundingClientRect();
      const q = range.getBoundingClientRect();
      return { name: name.top + name.height / 2, mark: q.top + q.height / 2 };
    });
    expect(Math.abs(tops.name - tops.mark), 'the question mark is on the project name\'s line').toBeLessThan(12);
  } finally { await end(); }
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 800, height: 900 } });
  test('actions that wait for hover are simply there', async ({ page }) => {
    const { end } = await open(page, 'prim-touch');
    try {
      await page.keyboard.press('ControlOrMeta+p');
      const more = page.getByRole('button', { name: 'More actions for note.md' });
      await expect(more).toBeAttached();
      expect(await more.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    } finally { await end(); }
  });
});

test('a pressed button looks pressed', async ({ page }) => {
  const { end } = await open(page, 'prim-press');
  try {
    const ghost = page.getByRole('button', { name: 'New project' });
    await ghost.hover();
    await page.waitForTimeout(300);
    const hovered = await ghost.evaluate((e) => getComputedStyle(e).backgroundColor);
    await page.mouse.down();
    await expect.poll(() => ghost.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(hovered);
    await page.mouse.up();
    await page.keyboard.press('Escape');
    expect(await style(page, 'html', 'color-scheme')).toBeDefined();
  } finally { await end(); }
});
