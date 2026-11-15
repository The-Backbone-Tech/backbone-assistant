import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// J-01 phases as reusable steps, driven only through what a person sees and does.
// Each step records {id, ok, evidence}; screenshots go to the repository's ignored evidence/ folder.
import { expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = join(appDir, '..', '..', '..');
export const evidenceDir = join(repoRoot, 'evidence', 'J-01');
export const fixture = (name: string) => join(appDir, 'e2e', 'fixtures', name);

export interface Phase {
  id: string;
  ok: boolean;
  evidence: string[];
  note?: string;
}

export class Recorder {
  readonly phases: Phase[] = [];
  readonly dir: string;
  readonly page: () => Page;
  constructor(dir: string, page: () => Page) {
    this.dir = dir;
    this.page = page;
    mkdirSync(dir, { recursive: true });
  }
  async shot(name: string): Promise<string> {
    const file = join(this.dir, `${name}.png`);
    await this.page().screenshot({ path: file });
    return file.slice(repoRoot.length + 1);
  }
  async phase(id: string, run: () => Promise<string[] | void>, note?: string) {
    try {
      const extra = (await run()) ?? [];
      // WCAG 1.4.10 reflow: no horizontal page scroll at any width, down to 320 px.
      const overflow = await this.page().evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
      this.phases.push({ id, ok: true, evidence: [...extra, await this.shot(id)], note });
    } catch (err) {
      const shot = await this.shot(`${id}-failed`).catch(() => '');
      this.phases.push({ id, ok: false, evidence: [shot, String(err).slice(0, 400)], note });
      throw err;
    }
  }
}

/** Calls the api port the same way the renderer does (IPC in Electron, HTTP in the browser). */
export function api<T = unknown>(page: Page, method: string, args: unknown): Promise<T> {
  return page.evaluate(
    async ([m, a]) => {
      const w = window as unknown as { backbone?: { call(m: string, a: unknown): Promise<unknown> } };
      if (w.backbone) return w.backbone.call(m as string, a);
      const r = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: m, args: a }) });
      return r.json();
    },
    [method, args] as const,
  ) as Promise<T>;
}

export const narrow = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

export async function openSidebar(page: Page) {
  if (narrow(page)) await page.getByRole('button', { name: 'Open sidebar' }).click();
}
export async function closeSidebar(page: Page) {
  if (narrow(page) && (await page.getByRole('button', { name: 'Close sidebar' }).isVisible())) await page.getByRole('button', { name: 'Close sidebar' }).click();
}
export async function openMoreView(page: Page, name: string) {
  const open = page.getByRole('button', { name: 'Open sidebar', exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole('navigation', { name: 'Projects and threads' }).getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
export async function closePaneOnNarrow(page: Page) {
  if (narrow(page) && (await page.getByTestId('pane').isVisible())) await page.getByRole('button', { name: 'Close pane' }).click();
}

export async function phase1Home(page: Page) {
  const home = page.getByTestId('home');
  await expect(home).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
  // A new data folder says once what Full access reaches; the person keeps it, and Home is then the one centred input.
  await page.getByRole('region', { name: 'Full access' }).getByRole('button', { name: 'Keep Full access' }).click();
  await expect(page.getByRole('region', { name: 'Full access' })).toHaveCount(0);
  // R-UX-HOME-01: one centred input and nothing below it.
  const check = await page.evaluate(() => {
    const homeEl = document.querySelector('[data-testid=home]') as HTMLElement;
    const inputs = homeEl.querySelectorAll('textarea, input:not([type=file])');
    const box = (homeEl.querySelector('textarea') as HTMLElement).closest('.rounded-2xl') as HTMLElement;
    const r = box.getBoundingClientRect();
    const h = homeEl.getBoundingClientRect();
    // The input's own controls sit under its box, as in the reference; nothing else does.
    const below = [...homeEl.querySelectorAll('*')].filter((el) => {
      if (el.closest('[data-testid=composer]')) return false;
      const e = el.getBoundingClientRect();
      return e.width > 0 && e.height > 0 && e.top >= r.bottom + 1 && !box.contains(el);
    });
    return { inputs: inputs.length, below: below.length, dx: Math.abs(r.left + r.width / 2 - (h.left + h.width / 2)), dy: Math.abs(r.top + r.height / 2 - (h.top + h.height / 2)) };
  });
  expect(check.inputs, 'one input').toBe(1);
  expect(check.below, 'nothing but its controls below the input').toBe(0);
  expect(check.dx, 'horizontally centred').toBeLessThan(2);
  expect(check.dy, 'vertically near the centre').toBeLessThan(80);
}

export async function phase2ProjectAndAttach(page: Page, name = 'Q4 review') {
  await openSidebar(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('navigation').getByRole('button', { name, exact: true })).toBeVisible();
  await closeSidebar(page);
  await expect(page.getByRole('heading', { name: new RegExp(`What should we work on in ${name}`) })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add files…' }).click();
  await (await chooser).setFiles([fixture('note.md'), fixture('data.xlsx')]);
  await expect(page.getByTestId('attachment-chip')).toHaveCount(2);
  // R-FILES-ORIG-01: the original bytes are kept.
  const projects = await api<{ id: string; name: string }[]>(page, 'projects.list', {});
  const project = projects.find((p) => p.name === name)!;
  const entries = await api<{ id: string; name: string; class: string }[]>(page, 'material.list', { projectId: project.id });
  const xlsx = entries.find((e) => e.name === 'data.xlsx')!;
  const back = await api<{ ok: boolean; value: { base64: string } }>(page, 'material.read', { id: xlsx.id });
  expect(back.value.base64).toBe(readFileSync(fixture('data.xlsx')).toString('base64'));
  expect(entries.every((e) => e.class === 'original')).toBe(true);
  return project.id;
}

/** Secondary document facts are available from the same compact header in every view. */
export async function expectDocumentInfo(page: Page, version?: string, state = 'Saved') {
  const trigger = page.getByRole('button', { name: 'Document options', exact: true });
  await trigger.click();
  if (version) await expect(page.getByTestId('file-version')).toContainText(version);
  await expect(page.getByTestId('document-state')).toHaveText(state);
  await page.keyboard.press('Escape');
  // Menu dismissal hands focus back asynchronously; later editor keys must wait for it.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

export async function phase3Brief(page: Page) {
  await page.getByRole('button', { name: /^Permissions:/ }).click();
  await page.getByRole('menuitemradio', { name: /Auto-review/ }).click();
  await page.getByRole('button', { name: /^Model and effort:/ }).click();
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Model and effort:.*High/ })).toBeVisible();
  await page.getByRole('button', { name: /^Work in:/ }).click();
  await page.getByRole('menuitemradio', { name: 'This computer' }).click();
  // The menu hands focus back as it closes; Enter pressed before that lands on its trigger.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Work in:/ })).toBeFocused();
  await page.getByRole('textbox', { name: 'Message' }).fill('Write an editable brief from these');
  await page.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(page.getByTestId('work-block').first()).toHaveText(/Worked for \d+/);
  await page.getByRole('button', { name: 'Chat details', exact: true }).click();
  const card = page.getByTestId('summary-card');
  await expect(card).toContainText('Q4 review');
  await expect(card).toContainText(/\+\d+/);
  await expect(card.getByRole('menuitem', { name: /note\.md/ })).toBeVisible();
  await expect(card.getByRole('menuitem', { name: /data\.xlsx/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('work-block').first().click();
  await expect(page.getByText(/Auto-review · High effort · This computer/)).toBeVisible();
}

const mod = (page: Page, key: string) => page.keyboard.press(`ControlOrMeta+${key}`);

export async function phase4Panes(page: Page) {
  await page.keyboard.press('Control+Shift+G');
  await expect(page.getByTestId('changes-tab')).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(6);
  await expect(page.getByTestId('changes-tab')).toContainText('brief.md');
  await mod(page, 'p');
  await expect(page.getByTestId('files-tab')).toBeVisible();
  // The pane's own tabs: the Files panel now has its own Files, Activity and Review tabs inside it.
  await expect(page.getByRole('tablist', { name: 'Pane tabs' }).getByRole('tab')).toHaveCount(2);
  await expect(page.getByTestId('file-row')).toHaveCount(3);
}

export async function phase5EditSave(page: Page) {
  await page.getByTestId('file-row').filter({ hasText: 'brief.md' }).click();
  await expect(page.getByTestId('file-tab').filter({ visible: true })).toBeVisible();
  await expectDocumentInfo(page, 'v1 · written by the agent');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit brief.md' });
  await editor.fill('# Brief\n\nPerson wording: we ship on Friday.\n');
  await expect(page.getByTestId('edit-state').filter({ visible: true })).toHaveText('Unsaved edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expectDocumentInfo(page, 'v2 · saved by you');
  await page.getByRole('tab', { name: /Files/ }).click();
  await expect(page.getByTestId('file-row').filter({ hasText: 'brief.md' })).toContainText('Saved');
}

export async function phase6SideChat(page: Page, projectId: string, runtime: 'model' | 'no-model' = 'no-model') {
  await page.keyboard.press(process.platform === 'darwin' ? 'Alt+Meta+S' : 'Control+Alt+S');
  await expect(page.getByTestId('side-chat-tab')).toBeVisible();
  // A read-only question should reach the model. Refusal of an actual attempted
  // write is exercised separately by the side-chat Host contract.
  await page.getByRole('textbox', { name: 'Ask the side chat' }).fill('What does the brief say?');
  await page.getByRole('textbox', { name: 'Ask the side chat' }).press('Enter');
  if (runtime === 'model') await expect(page.getByTestId('side-chat-tab')).toContainText('I read the current versions:', { timeout: TEST_HANG_MS });
  else await expect(page.getByRole('alert')).toContainText('Side questions need a configured model runtime.');
  const brief = (await api<{ name: string; current: number }[]>(page, 'material.list', { projectId })).find((e) => e.name === 'brief.md')!;
  expect(brief.current, 'no effect').toBe(2);
}

export async function prepareColdStart(page: Page) {
  await page.getByRole('tab', { name: /brief\.md/ }).click();
  await page.getByRole('textbox', { name: 'Edit brief.md' }).press('End');
  await page.getByRole('textbox', { name: 'Edit brief.md' }).pressSequentially(' Unsaved line.');
  await closePaneOnNarrow(page);
  await page.getByRole('textbox', { name: 'Message' }).fill('An unsent follow-up idea');
  await expect(page.getByTestId('draft-state')).toHaveText('Draft saved');
  await page.waitForTimeout(600);
}

export async function phase7Restored(page: Page) {
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  await expect(page.getByTestId('thread-title')).toHaveText('Write an editable brief from these');
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('An unsent follow-up idea');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (narrow(page)) await page.getByRole('button', { name: 'Show side pane' }).click();
  await expect(page.getByRole('tablist', { name: 'Pane tabs' }).getByRole('tab')).toHaveText([/Changes/, /Files/, /brief\.md/, /Side chat/]);
  // The editor is CodeMirror, a contenteditable textbox, so its text is read rather than an input value.
  await expect(page.getByRole('textbox', { name: 'Edit brief.md' })).toHaveText(/Unsaved line\./);
  await expect(page.getByTestId('edit-state').filter({ visible: true })).toHaveText('Unsaved edit');
  await closePaneOnNarrow(page);
}

export async function phase8FollowUp(page: Page) {
  await page.getByRole('textbox', { name: 'Message' }).fill('What does the brief say now?');
  await page.getByRole('textbox', { name: 'Message' }).press('Enter');
  const answer = page.getByTestId('answer').last();
  // Every harness names the version's class (original source / recorded version), never an inferred author.
  await expect(answer).toContainText('brief.md v2 (recorded version)');
  await expect(answer).toContainText('we ship on Friday');
  await expect(answer).not.toContainText('Unsaved line');
}

export async function phase10Classes(page: Page, projectId: string) {
  const files = await api<{ path: string; class: string }[]>(page, 'files.list', { projectId });
  expect(files.map((f) => [f.path, f.class]).sort()).toEqual([
    ['brief.md', 'accepted'],
    ['data.xlsx', 'original'],
    ['note.md', 'original'],
  ]);
  return [`files: ${files.map((f) => `${f.path}=${f.class}`).join(', ')}`];
}
