// Both tab strips with many tabs, on the real renderer and bridge: the conversation strip in the window
// bar and the side pane's strip. A label stays on one line; the active tab sits wholly inside the strip
// with its close control on top and working; the arrow keys reach every tab; a tab chosen off-screen
// is scrolled into view; the pane comes back with the same tabs after it is hidden. Screenshots of
// both strips with two, five and eight tabs go to the ignored evidence/ui-tabs/ folder.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startBridge, stopBridge } from './bridge';
import { api, narrow, openSidebar, repoRoot } from './journey';

const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };
const TOPICS = ['Quarterly plan for the northern region', 'Supplier contract renewal questions', 'Hiring brief for the support team', 'Board update on the harbour project', 'Customer interviews from last week', 'Pricing page draft and comments', 'Travel budget for the spring offsite', 'Weekly notes for the operations review'];
const DOCUMENTS = ['northern-region-quarterly-plan.md', 'supplier-contract-renewal-notes.md', 'harbour-project-board-update.md'];

async function opened(page: Page, label: string) {
  const home = freshDataHome(label);
  const bridge = await startBridge(home);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(bridge.url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  const project = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Launch', kind: 'folder' });
  const projectId = project.value.id;
  for (const name of DOCUMENTS) await api(page, 'material.attach', { projectId, name, base64: Buffer.from(`# ${name}\n`).toString('base64'), mediaType: 'text/markdown' });
  const threads: string[] = [];
  for (const [i, text] of TOPICS.entries()) {
    const sent = await api<{ ok: boolean; value: { threadId: string } }>(page, 'turns.send', { projectId, text, attachments: [], settings, clientKey: `tabs-${i}` });
    expect(sent.ok).toBe(true);
    threads.push(sent.value.threadId);
  }
  await expect.poll(async () => (await Promise.all(threads.map((id) => api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id })))).every((t) => !t.value.summary.running)).toBe(true);
  const materials = await api<{ id: string; name: string }[] | { value: { id: string; name: string }[] }>(page, 'material.list', { projectId });
  const list = Array.isArray(materials) ? materials : materials.value;
  const documents = DOCUMENTS.map((name) => list.find((m) => m.name === name)!.id);
  return { projectId, threads, documents, errors, end: async () => { await stopBridge(bridge.proc); await removeDataHome(home); } };
}

/** Puts the viewer's layout in place and reloads, as a person reopening the window would find it. */
async function layout(page: Page, change: (prefs: Record<string, unknown>) => Record<string, unknown>) {
  const prefs = await api<Record<string, unknown>>(page, 'viewer.get', {});
  await api(page, 'viewer.put', { prefs: change(prefs) });
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.locator('[data-ready=true]')).toBeVisible();
}

function shots(page: Page, project: string) {
  const dir = join(repoRoot, 'evidence', 'ui-tabs', project);
  mkdirSync(dir, { recursive: true });
  return (name: string) => page.screenshot({ path: join(dir, `${name}.png`) });
}

interface TabFacts { name: string; selected: boolean; lines: number; inside: boolean }

/** Each tab of a strip: its name, whether it is selected, how many lines its label takes and whether it lies wholly inside the strip's visible area. */
function facts(list: Locator): Promise<TabFacts[]> {
  return list.evaluate((strip) => {
    const view = strip.getBoundingClientRect();
    return [...strip.querySelectorAll<HTMLElement>('[role=tab]')].map((tab) => {
      const tops = new Set<number>();
      const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top / 4));
      }
      const box = tab.getBoundingClientRect();
      return { name: tab.getAttribute('aria-label') ?? tab.textContent?.trim() ?? '', selected: tab.getAttribute('aria-selected') === 'true', lines: tops.size, inside: box.left >= view.left - 1 && box.right <= view.right + 1 && box.width > 0 };
    });
  });
}

/** The control is wholly inside the strip's visible area, shown, and the topmost thing at its centre. */
async function reachable(list: Locator, control: Locator, soft = false) {
  const check = soft ? expect.soft : expect;
  await check(control).toBeVisible();
  if (!(await control.count())) return;
  await check.poll(() => control.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  const result = await control.evaluate((button, strip) => {
    const box = button.getBoundingClientRect();
    const view = strip!.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { inside: box.left >= view.left - 1 && box.right <= view.right + 1, onTop: !!top && button.contains(top), covering: top?.getAttribute('aria-label') ?? top?.tagName };
  }, await list.elementHandle());
  check(result.inside, 'inside the strip').toBe(true);
  check(result.onTop, `on top (found ${result.covering})`).toBe(true);
}

/** The arrow keys walk the whole strip, and the tab the keyboard is on is always in view. */
async function walk(page: Page, list: Locator, count: number) {
  await list.getByRole('tab', { selected: true }).focus();
  const focusedName = () => page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement.textContent!.trim() : '');
  const seen = new Set<string>();
  let previous = '';
  for (let i = 0; i < count + 1; i++) {
    // The tab list moves the keyboard a moment after the key: wait for it before the next key.
    await expect.poll(focusedName).not.toBe(previous);
    const name = await focusedName();
    expect(name, 'the keyboard is on a tab').not.toBe('');
    seen.add(name);
    previous = name;
    const focused = list.locator('[role=tab]:focus');
    const inside = await focused.evaluate((tab, strip) => {
      const box = tab.getBoundingClientRect();
      const view = strip!.getBoundingClientRect();
      return box.left >= view.left - 1 && box.right <= view.right + 1;
    }, await list.elementHandle());
    expect(inside, `${name} is in view while it has the keyboard`).toBe(true);
    await page.keyboard.press('ArrowRight');
  }
  return seen;
}

async function checkStrip(page: Page, list: Locator, closeName: (tab: string) => RegExp, count: number) {
  const all = await facts(list);
  expect(all, 'every tab is there').toHaveLength(count);
  for (const tab of all) expect(tab.lines, `${tab.name} stays on one line`).toBe(1);
  const active = all.find((tab) => tab.selected)!;
  expect(active.inside, `${active.name}, the active tab, is wholly in view`).toBe(true);
  await reachable(list, page.getByRole('button', { name: closeName(active.name) }));
  expect(await list.getByRole('tab', { selected: true }).evaluate((e) => getComputedStyle(e).fontSize)).toBe('13px');
  // Every tab is reachable with the arrow keys, as a tab list is.
  expect([...(await walk(page, list, count))].sort()).toEqual(all.map((tab) => tab.name).sort());
}

/** Scrolls the strip to the far end from the target, then chooses it from the list of all tabs: it comes into view selected. */
async function chooseOffscreen(page: Page, list: Locator, name: string, allTabs: string) {
  await list.evaluate((strip) => { strip.scrollLeft = 0; });
  const target = list.getByRole('tab', { name });
  const before = await target.evaluate((tab, strip) => tab.getBoundingClientRect().right <= strip!.getBoundingClientRect().right + 1, await list.elementHandle());
  if (before) await list.evaluate((strip) => { strip.scrollLeft = strip.scrollWidth; });
  // The list of every tab is reached from the end of the strip, and a few typed letters find one.
  await page.getByRole('button', { name: allTabs }).click();
  const find = page.getByRole('combobox', { name: 'Find a tab' });
  await expect(find).toBeFocused();
  await find.fill(name.slice(0, 6));
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
  await expect(target).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await facts(list)).find((tab) => tab.selected)?.inside).toBe(true);
}

test('the conversation strip holds eight conversations', async ({ page }, info) => {
  const shot = shots(page, info.project.name);
  const { projectId, threads, errors, end } = await opened(page, 'tabs-conversations');
  try {
    // At 1440 the side pane is open beside the conversation, as when the label was seen wrapping.
    await layout(page, (p) => ({ ...p, selectedProjectId: projectId, selectedThreadId: undefined, pane: narrow(page) ? { open: false, tabs: [], active: null } : { open: true, tabs: [{ id: 'files', kind: 'files' }], active: 'files' } }));
    const list = page.getByRole('tablist', { name: 'Open conversations' });
    const sidebar = page.getByRole('navigation', { name: 'Projects and threads' });
    for (const [i, topic] of TOPICS.entries()) {
      await openSidebar(page);
      await sidebar.locator('[data-row-main]', { hasText: topic }).first().click();
      await expect(page.getByTestId('thread-title')).toHaveText(topic);
      if (i === 1 || i === 4) await shot(`conversations-${i + 1}`);
    }
    await expect(list.getByRole('tab')).toHaveCount(8);
    await shot('conversations-8');
    // A new chat beside eight conversations: its label stays on one line too, and it is in view.
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(list.getByRole('tab', { name: 'New chat' })).toHaveAttribute('aria-selected', 'true');
    await shot('conversations-8-new-chat');
    for (const tab of await facts(list)) expect.soft(tab.lines, `${tab.name} stays on one line`).toBe(1);
    expect.soft((await facts(list)).find((tab) => tab.selected)?.inside, 'New chat is in view').toBe(true);
    await openSidebar(page);
    await sidebar.locator('[data-row-main]', { hasText: TOPICS[7] }).first().click();
    await expect(page.getByTestId('thread-title')).toHaveText(TOPICS[7]);
    await checkStrip(page, list, (name) => new RegExp(`^Close conversation view ${name}`), 8);
    await chooseOffscreen(page, list, TOPICS[0], 'Show all tabs');
    await chooseOffscreen(page, list, TOPICS[7], 'Show all tabs');
    // The active conversation's close control closes it, and the keyboard lands on the one now shown.
    await page.getByRole('button', { name: new RegExp(`^Close conversation view ${TOPICS[7]}`) }).click();
    await expect(list.getByRole('tab')).toHaveCount(7);
    await expect(list.getByRole('tab', { name: TOPICS[7] })).toHaveCount(0);
    await expect(list.getByRole('tab', { selected: true })).toBeFocused();
    expect(threads).toHaveLength(8);
    expect(errors).toEqual([]);
  } finally { await end(); }
});

test('the pane strip holds eight tabs', async ({ page }, info) => {
  const shot = shots(page, info.project.name);
  const { projectId, threads, documents, errors, end } = await opened(page, 'tabs-pane');
  try {
    const tabs = [{ id: 'files', kind: 'files' }, { id: `file:${documents[0]}`, kind: 'file', materialId: documents[0] }, { id: `file:${documents[1]}`, kind: 'file', materialId: documents[1] }, { id: 'terminal', kind: 'terminal' }, { id: 'changes', kind: 'changes' }, { id: 'side-chat', kind: 'side-chat' }, { id: `file:${documents[2]}`, kind: 'file', materialId: documents[2] }, { id: 'browser', kind: 'browser' }];
    const list = page.getByRole('tablist', { name: 'Pane tabs' });
    // As seen on 14 November: Files, two documents and the Browser, which is active.
    const seen = [tabs[0], tabs[1], tabs[2], tabs[7]];
    for (const shown of [tabs.slice(0, 2), seen, [...tabs.slice(0, 4), tabs[7]], tabs]) {
      await layout(page, (p) => ({ ...p, selectedProjectId: projectId, selectedThreadId: threads[0], pane: { open: true, tabs: shown, active: shown.at(-1)!.id } }));
      await expect(list.getByRole('tab')).toHaveCount(shown.length);
      await expect(list.getByRole('tab', { name: DOCUMENTS[0] })).toBeVisible();
      await shot(`pane-${shown.length}${shown === seen ? '-as-seen' : ''}`);
      // Soft, so that every count is photographed and measured before the test reports.
      const all = await facts(list);
      for (const tab of all) expect.soft(tab.lines, `${tab.name} stays on one line with ${shown.length} tabs`).toBe(1);
      expect.soft(all.find((tab) => tab.selected)?.inside, `the active tab is wholly in view with ${shown.length} tabs`).toBe(true);
      await reachable(list, page.getByRole('button', { name: `Close ${all.find((tab) => tab.selected)!.name}`, exact: true }), true);
    }
    await checkStrip(page, list, (name) => new RegExp(`^Close ${name}$`), 8);
    await chooseOffscreen(page, list, 'Files', 'Show all tabs');
    await chooseOffscreen(page, list, 'Browser', 'Show all tabs');
    // The top bar holds the tabs, New tab, one menu and Close pane; the document's own actions sit in its content.
    await list.getByRole('tab', { name: DOCUMENTS[0] }).click();
    const bar = page.getByTestId('workspace-bar');
    for (const name of ['Edit', 'Full screen', 'Document options', 'Browse files']) await expect(bar.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(page.getByTestId('file-tab').filter({ visible: true }).getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Pane options', exact: true })).toBeVisible();
    // A file tab names its version in its help and in the list, however narrow it is.
    await expect(list.getByRole('tab', { name: DOCUMENTS[1] })).toHaveAttribute('title', `${DOCUMENTS[1]} · v1`);
    // Ctrl+Tab goes back to the tab used before, as editors do.
    await list.getByRole('tab', { name: 'Browser' }).click();
    await list.getByRole('tab', { name: 'Files' }).click();
    await page.keyboard.press('Control+Tab');
    await expect(list.getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');
    // A middle click closes a tab that is not active, and nothing else changes.
    await list.getByRole('tab', { name: 'Changes' }).click({ button: 'middle' });
    await expect(list.getByRole('tab')).toHaveCount(7);
    await expect(list.getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');
    // The active tab's close control closes it, and the keyboard lands on the one now shown.
    await page.getByRole('button', { name: 'Close Browser', exact: true }).click();
    await expect(list.getByRole('tab')).toHaveCount(6);
    await expect(list.getByRole('tab', { selected: true })).toBeFocused();
    expect((await facts(list)).find((tab) => tab.selected)?.inside).toBe(true);
    expect(errors).toEqual([]);
  } finally { await end(); }
});

test('the pane comes back with the same tabs after it is hidden', async ({ page }) => {
  const { projectId, threads, documents, end } = await opened(page, 'tabs-restore');
  try {
    const tabs = [{ id: 'files', kind: 'files' }, { id: `file:${documents[0]}`, kind: 'file', materialId: documents[0] }, { id: 'terminal', kind: 'terminal' }, { id: `file:${documents[1]}`, kind: 'file', materialId: documents[1] }];
    await layout(page, (p) => ({ ...p, selectedProjectId: projectId, selectedThreadId: threads[0], pane: { open: true, tabs, active: 'terminal' } }));
    const list = page.getByRole('tablist', { name: 'Pane tabs' });
    await list.getByRole('tab', { name: DOCUMENTS[0] }).click();
    await expect(list.getByRole('tab', { name: DOCUMENTS[0] })).toHaveAttribute('aria-selected', 'true');
    const before = await facts(list);
    await page.getByRole('button', { name: 'Close pane' }).click();
    await expect(page.getByTestId('pane')).toBeHidden();
    await page.getByRole('button', { name: 'Show side pane' }).click();
    await expect(page.getByTestId('pane')).toBeVisible();
    expect((await facts(list)).map(({ name, selected }) => ({ name, selected }))).toEqual(before.map(({ name, selected }) => ({ name, selected })));
    await expect(page.getByTestId('file-tab').filter({ visible: true })).toBeVisible();
    // And after the window is opened again.
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await expect(list.getByRole('tab', { name: DOCUMENTS[1] })).toBeVisible();
    expect((await facts(list)).map(({ name, selected }) => ({ name, selected }))).toEqual(before.map(({ name, selected }) => ({ name, selected })));
    // A command still running in the Terminal says so in its tab's help, and closing the pane stops nothing.
    await list.getByRole('tab', { name: 'Terminal' }).click();
    await page.getByRole('textbox', { name: 'Terminal command' }).fill('sleep 6');
    await page.getByRole('textbox', { name: 'Terminal command' }).press('Enter');
    await expect(list.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('title', 'Terminal · running');
    await list.getByRole('tab', { name: DOCUMENTS[0] }).click();
    await expect(list.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('title', 'Terminal · running');
    await expect(list.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('title', 'Terminal', { timeout: 15_000 });
    // A document that can no longer be read says so inside its tab; the tab stays.
    await page.route('**/api', async (route) => {
      const body = route.request().postDataJSON() as { method: string; args: { id?: string } };
      if (body.method === 'material.read' && body.args.id === documents[1]) return route.fulfill({ json: { ok: false, detail: 'This document could not be read.' } });
      return route.continue();
    });
    await list.getByRole('tab', { name: /^File$|supplier-contract/ }).click();
    const panel = page.getByTestId('pane').getByRole('tabpanel');
    await expect(panel.getByRole('alert')).toHaveText('This document could not be read.');
    await expect(panel.getByRole('button', { name: 'Retry document' })).toBeVisible();
    await expect(list.getByRole('tab')).toHaveCount(4);
  } finally { await end(); }
});
