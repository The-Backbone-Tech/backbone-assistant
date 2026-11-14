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
  await page.getByRole('navigation').getByRole('button', { name: 'Launch' }).click();
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
    const language = page.getByRole('combobox', { name: 'Language' });
    await expect(language).toBeVisible();
    expect((await language.boundingBox())!.height).toBe(32);
    expect(await language.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe('6px');
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
    await send(page, 'Second');
    await expect(page.getByRole('tablist', { name: 'Open conversations' })).toBeVisible();
    const close = page.getByRole('button', { name: /^Close conversation view Second/ });
    await page.mouse.move(0, 0);
    await expect.poll(() => close.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    const tab = page.getByRole('tab', { name: /Second/ });
    expect(await tab.evaluate((e) => getComputedStyle(e).fontSize), 'the interface size token wins').toBe('13px');
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
