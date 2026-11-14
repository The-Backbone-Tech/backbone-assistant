import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// The Now page and the Codex model setting on the built Electron app, unpacked or installed, through
// what a person sees and does. Now runs on Pi and the scripted model. The model setting runs on the
// native engine against a fake client that records each turn, so the proof is what the client was
// asked for, not what the screen says. No network, no key and no quota.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { scriptedStep, startScriptedModel, type Message, type ScriptedModel } from '@backbone-next/platform/testing';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, appDir, fixture, openMoreView, repoRoot } from './journey';

const installed = process.env.BACKBONE_APP_EXECUTABLE;
const evidence = join(repoRoot, 'evidence', installed ? 'now-installed' : 'now');
const LONG = `${'a-document-whose-name-has-no-spaces-to-break-at-'.repeat(3)}end.md`;
const settings = { permission: 'full', model: 'scripted-model', effort: 3, runsOn: 'this-computer', mode: 'chat' };
let app: ElectronApplication | undefined;
let page: Page;
let model: ScriptedModel | undefined;
const homes: string[] = [];
const scratch: string[] = [];

interface Turn { status: string; work: { harness: string }; effects: { key: string; target: string; outcome: string }[] }
interface Thread { summary: { running: boolean }; turns: Turn[] }
type Receipt<T> = { ok: true; value: T } | { ok: false; reason: string; detail: string };
const value = async <T>(r: Promise<Receipt<T>>) => { const v = await r; if (!v.ok) throw new Error(v.detail); return v.value; };

function newHome(label: string) {
  const home = installed ? mkdtempSync(join(tmpdir(), `backbone-${label}-installed-`)) : freshDataHome(`${label}-electron`);
  homes.push(home);
  return home;
}

async function launch(env: Record<string, string>) {
  const runtime = { env: { ...process.env, ...env } as Record<string, string> };
  app = await electron.launch(installed ? { ...runtime, executablePath: installed, args: [] } : { ...runtime, args: [appDir] });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
}
// A person's quit: closing the window alone keeps the app and its work running on macOS.
const quit = async () => {
  const leaving = app?.waitForEvent('close', { timeout: TEST_HANG_MS }).catch(() => undefined);
  await app?.evaluate(({ app }) => { app.quit(); }).catch(() => undefined);
  await leaving;
  app = undefined;
};
const size = (w: number, h: number) => app!.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h] as const);
const shot = (name: string) => page.screenshot({ path: join(evidence, `${name}.png`) });
const thread = (id: string) => value(api<Receipt<Thread>>(page, 'threads.get', { id }));
async function settled(id: string, timeout = 60_000) {
  await expect.poll(async () => { const t = await thread(id); return t.turns.length > 0 && !t.summary.running; }, { timeout }).toBe(true);
  return thread(id);
}

/** Nothing on the page reaches past the window's edge, and nothing inside it is cut off sideways. */
async function fits(where: string) {
  const over = await page.evaluate(() => {
    const width = window.innerWidth;
    const now = document.querySelector('[data-testid=now]') as HTMLElement | null;
    const past = [...document.querySelectorAll('[data-testid=work-now] button, [data-testid=work-now] p, [data-testid=work-now] summary')]
      .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > width + 0.5)
      .map((el) => el.textContent?.slice(0, 40));
    return { page: document.documentElement.scrollWidth - width, now: now ? now.scrollWidth - now.clientWidth : 0, past };
  });
  expect(over, where).toEqual({ page: 0, now: 0, past: [] });
}

test.beforeAll(() => { mkdirSync(evidence, { recursive: true }); });
test.afterAll(async () => {
  await quit();
  await model?.close();
  for (const home of homes) await removeDataHome(home);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The scripted model, plus one way to write a document of a given name and to answer with no file. */
function script(messages: Message[]) {
  const start = messages.findLastIndex((m) => m.role === 'user');
  const asked = JSON.stringify(messages[start].content);
  const name = /named (\S+?\.md)/.exec(asked)?.[1];
  const piece = /Finish piece (\d)/.exec(asked)?.[1];
  const done = messages.slice(start + 1).filter((m) => m.role === 'tool').length;
  if (asked.includes('Read hiring.md, then write two documents')) {
    if (done === 0) return { calls: [{ name: 'read_file', args: { name: 'hiring.md' } }] };
    if (done < 3) return { calls: [{ name: 'write_file', args: { name: done === 1 ? 'first.md' : 'second.md', content: `# Draft ${done}\n` } }] };
    return { text: 'Wrote both.' };
  }
  if (piece) return { text: `Piece ${piece} is finished.\nThe rest stays in the thread.` };
  if (!name) return scriptedStep(messages);
  return messages.slice(start + 1).some((m) => m.role === 'tool') ? { text: `Wrote ${name}.` } : { calls: [{ name: 'write_file', args: { name, content: `# ${name}\n\nDraft.\n` } }] };
}

test('Now: unfinished work first, Keep, Retire and Bring back, disclosure, a person’s document stays, at every width', async () => {
  test.setTimeout(300_000);
  model = await startScriptedModel('scripted-model', script);
  const home = newHome('now');
  const route = { BACKBONE_HOME: home, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model };
  // Slow enough that the last write is still running when it is watched and stopped.
  await launch({ ...route, BACKBONE_STUB_WRITE_DELAY_MS: '2500' });
  const p = await value(api<Receipt<{ id: string }>>(page, 'projects.create', { name: 'Launch', kind: 'folder' }));
  const send = (text: string, clientKey: string, threadId?: string) => value(api<Receipt<{ threadId: string }>>(page, 'turns.send', { threadId, projectId: p.id, text, attachments: [], settings, clientKey }));
  const names = ['scratch-1.md', 'scratch-2.md', 'scratch-3.md', 'scratch-4.md', LONG];
  for (const [i, name] of names.entries()) {
    const { threadId } = await send(`Write a document named ${name}.`, `w${i}`);
    expect((await settled(threadId)).turns[0].status, name).toBe('done');
    // Its thread has moved on, so nothing presents the document any more: it is temporary output.
    await settled((await send(`Finish piece ${i + 1}`, `f${i}`, threadId)).threadId);
  }
  await page.reload();
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Launch' }).click();
  await openMoreView(page, 'Now');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Now', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  const view = page.getByTestId('work-now');

  const { threadId: stopped } = await send('Write a document named interrupted.md.', 'stop');
  await expect(view, 'running work shows without a reload').toContainText('Working: Write a document named interrupted.md.');
  await value(api(page, 'turns.stop', { threadId: stopped }));
  await settled(stopped);
  await expect(view.getByTestId('now-needs-you').first(), 'stopped work needs the person, without a reload').toBeVisible();

  const order = await view.evaluate((el) => {
    const at = (id: string) => [...el.querySelectorAll('*')].findIndex((e) => e.getAttribute('data-testid') === id);
    return [at('now-needs-you'), at('now-progress'), at('now-temporary')];
  });
  expect(order.every((n) => n >= 0), 'all three are shown').toBe(true);
  expect(order, 'unfinished work first, then progress, then temporary output').toEqual([...order].sort((a, b) => a - b));

  // Older progress waits behind a disclosure, most recent first.
  await expect(view.getByTestId('now-recent').locator('> [data-testid=now-progress]')).toHaveCount(3);
  await expect(view.getByTestId('now-recent').locator('> [data-testid=now-progress]').first()).toContainText('Piece 5 is finished.');
  const older = view.getByTestId('now-older-progress');
  await expect(older.getByTestId('now-progress').first()).toBeHidden();
  await older.locator('summary').click();
  await expect(older.getByTestId('now-progress')).toHaveCount(2);
  await expect(older.getByTestId('now-progress').first()).toBeVisible();
  await expect(view).not.toContainText('The rest stays in the thread.');

  const row = (name: string) => view.getByTestId('now-temporary').filter({ hasText: name });
  await expect(view.getByTestId('now-temporary')).toHaveCount(5);
  await shot('1440-now');
  await fits('1440');

  await row('scratch-1.md').getByRole('button', { name: 'Keep' }).click();
  await expect(view.getByTestId('now-temporary')).toHaveCount(4);
  await expect(view.getByRole('button', { name: 'scratch-1.md v1' })).toBeVisible();

  await row('scratch-2.md').getByRole('button', { name: 'Retire' }).click();
  await expect(view.getByTestId('now-temporary')).toHaveCount(3);
  const retired = view.getByTestId('now-retired');
  await expect(retired.locator('summary')).toHaveText('1 retired, every version kept');
  await expect(retired.getByText('scratch-2.md v1')).toBeHidden();
  await retired.locator('summary').click();
  await expect(retired.getByText('scratch-2.md v1')).toBeVisible();
  await retired.getByRole('button', { name: 'Bring back' }).click();
  await expect(view.getByTestId('now-temporary')).toHaveCount(4);
  await expect(view.getByTestId('now-retired')).toHaveCount(0);
  await row('scratch-2.md').getByRole('button', { name: 'Retire' }).click();
  await expect(view.getByTestId('now-retired').locator('summary')).toBeVisible();
  const entries = () => api<{ id: string; name: string; current: number; hidden?: boolean }[]>(page, 'material.list', { projectId: p.id, includeHidden: true });
  const entry = async (name: string) => (await entries()).find((e) => e.name === name)!;
  const hiddenOne = await entry('scratch-2.md');
  expect(hiddenOne.hidden).toBe(true);
  expect((await value(api<Receipt<{ text: string }>>(page, 'material.read', { id: hiddenOne.id }))).text, 'retiring deletes nothing').toContain('# scratch-2.md');

  // A person's Save makes a document theirs: it leaves temporary output and retiring it is refused.
  await row('scratch-3.md').getByRole('button', { name: 'scratch-3.md v1' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit scratch-3.md' }).fill('# Mine\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row('scratch-3.md'), 'without a reload').toHaveCount(0);
  await expect(view.getByRole('button', { name: 'scratch-3.md v2' })).toContainText('saved by you');
  const mine = await entry('scratch-3.md');
  const refused = await api<Receipt<unknown>>(page, 'material.lifecycle', { id: mine.id, version: 2, state: 'retired' });
  expect(refused).toMatchObject({ ok: false, reason: 'INVALID' });

  // An edit not yet saved is a person's work too: Retire is refused, says so, and nothing is hidden.
  await row('scratch-4.md').getByRole('button', { name: 'scratch-4.md v1' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Edit scratch-4.md' }).fill('# Unsaved edit\n');
  await expect(page.getByTestId('edit-state')).toHaveText('Unsaved edit');
  await page.waitForTimeout(800);
  await row('scratch-4.md').getByRole('button', { name: 'Retire' }).click();
  await expect(view.getByTestId('now-problem')).toContainText('it stays');
  expect((await entry('scratch-4.md')).hidden ?? false).toBe(false);
  await shot('1440-now-refused');
  await page.getByRole('button', { name: 'Close pane' }).click();

  // A line of unfinished work goes to that work.
  await view.getByTestId('now-needs-you').first().click();
  await expect(page.getByRole('region', { name: 'Write a document named interrupted.md.' })).toBeVisible();
  await openMoreView(page, 'Now');

  // What was decided survives a quit and a cold start, and the page comes back where it was.
  await quit();
  await launch(route);
  await expect(page.getByTestId('now')).toBeVisible();
  const reopened = page.getByTestId('work-now');
  await expect(reopened.getByTestId('now-needs-you').first()).toBeVisible();
  await expect(reopened.getByRole('button', { name: 'scratch-1.md v1' })).toBeVisible();
  await expect(reopened.getByTestId('now-retired').locator('summary')).toHaveText('1 retired, every version kept');
  await expect(reopened.getByTestId('now-temporary').filter({ hasText: 'scratch-1.md' })).toHaveCount(0);

  await reopened.getByTestId('now-older-progress').locator('summary').click();
  await reopened.getByTestId('now-retired').locator('summary').click();
  for (const [w, h] of [[1440, 900], [768, 900], [375, 812], [320, 640]] as const) {
    await size(w, h);
    await page.waitForTimeout(300);
    await shot(`${w}-now-open`);
    await fits(`${w} px`);
  }
  await size(1440, 900);

  // Another project's page never shows the last one's refusal or its documents.
  await value(api(page, 'projects.create', { name: 'Other', kind: 'folder' }));
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Other' })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Other' }).click();
  await expect(page.getByTestId('now'), 'choosing a project leaves the page').toHaveCount(0);
  await openMoreView(page, 'Now');
  await expect(reopened.getByTestId('now-temporary')).toHaveCount(0);
  await expect(reopened.getByTestId('now-problem')).toHaveCount(0);
  await expect(reopened).toContainText('Nothing is unfinished.');
  await quit();
});

test('a turn caught by a withdrawal leaves its work held, and the person decides', async () => {
  test.setTimeout(180_000);
  const deadline = Date.now() + test.info().timeout;
  const remaining = () => Math.max(1, deadline - Date.now() - 2_000);
  const home = newHome('now-held');
  await launch({ BACKBONE_HOME: home, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model!.url, BACKBONE_MODEL_ID: model!.model, BACKBONE_STUB_WRITE_DELAY_MS: '10000' });
  const p = await value(api<Receipt<{ id: string }>>(page, 'projects.create', { name: 'Held', kind: 'folder' }));
  const source = await value(api<Receipt<{ id: string; current: number; lifecycle?: number }>>(page, 'material.attach', { projectId: p.id, name: 'hiring.md', base64: Buffer.from('# Hiring\n').toString('base64'), mediaType: 'text/markdown' }));
  const { threadId } = await value(api<Receipt<{ threadId: string }>>(page, 'turns.send', { projectId: p.id, text: 'Read hiring.md, then write two documents', attachments: [source.id], settings, clientKey: 'held' }));
  // Observe the admitted first write, not merely a provisional effect, before withdrawing.
  await expect.poll(async () => (await thread(threadId)).turns[0]?.effects.some(e => e.target === 'first.md' && !!e.key && e.outcome === 'UNKNOWN'), { intervals: [50], timeout: remaining() }).toBe(true);
  await value(api(page, 'material.lifecycle', { id: source.id, version: source.current, state: 'withdrawn', lifecycle: source.lifecycle ?? 0 }));
  await settled(threadId, remaining());
  await expect.poll(async () => (await api<{ needsYou: {kind:string;title:string}[] }>(page, 'work.now', {projectId:p.id})).needsYou.some(item => item.kind === 'held' && item.title.includes('second')), {timeout:remaining()}).toBe(true);

  await page.getByRole('navigation').getByRole('button', { name: 'Held' }).click();
  await openMoreView(page, 'Now');
  const view = page.getByTestId('work-now');
  await expect(view.getByTestId('now-withdrawn').filter({ hasText: 'hiring.md' })).toBeVisible();
  const held = view.getByTestId('now-needs-you').filter({ hasText: 'second' });
  await expect(held).toContainText('v1', {timeout:remaining()});
  await shot('1440-now-held');
  const names = () => api<{ name: string }[]>(page, 'material.list', { projectId: p.id });
  expect((await names()).map((m) => m.name).some((n) => /second/.test(n)), 'out of reach until decided').toBe(false);
  await expect(view.getByRole('button', { name: /first\.md v1/ }), 'what crossed before the withdrawal stays visible').toBeVisible();
  const heldId = (await api<{ needsYou: { kind: string; materialId?: string }[] }>(page, 'work.now', { projectId: p.id })).needsYou.find((n) => n.kind === 'held')!.materialId;
  const refused = await api<Receipt<unknown>>(page, 'turns.send', { projectId: p.id, text: 'Use the held draft', attachments: [heldId], settings, clientKey: 'held-attachment' });
  expect(refused).toMatchObject({ ok: false, reason: 'INVALID' });
  await held.getByRole('button', { name: 'Allow in later work' }).click();
  await expect(held).toHaveCount(0);
  expect((await names()).map((m) => m.name).some((n) => /second/.test(n)), 'released').toBe(true);
  await quit();
});

test('Codex model: the choice in Settings or the composer is what the next turn asks the client for', async () => {
  test.setTimeout(240_000);
  const bin = mkdtempSync(join(tmpdir(), 'backbone-fake-codex-'));
  scratch.push(bin);
  const log = join(bin, 'turns.jsonl');
  writeFileSync(log, '');
  const client = join(repoRoot, 'packages/modules/harness-codex/test/fixtures/native.mjs');
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec '${process.execPath}' '${fixture('codex-client.mjs')}' '${log}' '${client}' "$@"\n`);
  chmodSync(join(bin, 'codex'), 0o755);
  const asked = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { model: string; effort: string });
  const env = {
    BACKBONE_HOME: newHome('codex-model'), BACKBONE_HARNESS: 'harness-codex', BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath,
    PATH: `${bin}:${process.env.PATH}`, BACKBONE_MODEL_ENDPOINT: '', BACKBONE_MODEL_ID: '',
  };
  await launch(env);
  const p = await value(api<Receipt<{ id: string }>>(page, 'projects.create', { name: 'Native', kind: 'folder' }));
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Native' })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Native' }).click();
  const composer = () => page.getByRole('button', { name: /^Model and effort:/ });
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const choose = async (label: string) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await dialog.getByRole('button', { name: 'AI and models' }).click();
    await dialog.getByLabel('Codex model').selectOption({ label });
  };
  const closeSettings = () => dialog.getByRole('button', { name: 'Done' }).click();
  const say = async (text: string) => {
    const before = (await api<{ id: string }[]>(page, 'threads.list', {})).length;
    await page.getByRole('textbox', { name: 'Message' }).fill(text);
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect.poll(async () => (await api<{ id: string }[]>(page, 'threads.list', {})).length).toBe(before + 1);
    const [{ id }] = await api<{ id: string }[]>(page, 'threads.list', {});
    const turn = (await settled(id)).turns.at(-1)!;
    await page.getByRole('button', { name: 'New chat' }).click();
    return turn;
  };

  // Nothing chosen: the first model, at its own effort.
  await expect(composer()).toContainText('Fast model');
  expect(await say('First')).toMatchObject({ status: 'done', work: { harness: expect.stringContaining('Codex · fast-model') } });
  expect(asked().at(-1)).toEqual({ model: 'fast-model', effort: 'medium' });

  // Touching the composer's effort must not pin the model against a later choice in Settings.
  await composer().click();
  await page.getByRole('menuitemradio', { name: 'Low' }).click();
  await expect(composer()).toHaveAccessibleName(/Fast model, Low/);

  // The Deep model takes only high and xhigh: what the composer offers and sends follows the model.
  await choose('Deep model');
  await expect(dialog.getByTestId('model-active')).toContainText('Codex · deep-model');
  await shot('1440-settings-codex-model');
  await size(375, 812);
  await page.waitForTimeout(300);
  await shot('375-settings-codex-model');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
  await size(1440, 900);
  await closeSettings();
  await expect(composer()).toHaveAccessibleName(/Deep model, High/);
  expect(await say('Second')).toMatchObject({ status: 'done', work: { harness: expect.stringContaining('Codex · deep-model') } });
  expect(asked().at(-1)).toEqual({ model: 'deep-model', effort: 'high' });

  await composer().click();
  await page.getByRole('menuitemradio', { name: 'Max' }).click();
  await expect(composer()).toHaveAccessibleName(/Deep model, Max/);

  // Back to the Fast model, whose top effort is below where the slider now stands.
  await choose('Fast model');
  await closeSettings();
  await expect(composer()).toHaveAccessibleName(/Fast model, Medium/);
  expect(await say('Third')).toMatchObject({ status: 'done' });
  expect(asked().at(-1)).toEqual({ model: 'fast-model', effort: 'medium' });

  // The composer's own menu is the same choice: Settings says what the next turn really uses.
  // Another Electron spec in the second worker can take the screen's focus with a native dialog, which
  // closes an open menu. The person would simply open it again, so the choice is retried from the top.
  await expect(async () => {
    if (!await page.getByRole('menuitem', { name: /^Model:/ }).isVisible()) await composer().click();
    await page.getByRole('menuitem', { name: /^Model:/ }).hover();
    await page.getByRole('menuitemradio', { name: 'Deep model' }).click({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(composer()).toHaveAccessibleName(/Deep model/);
  await page.getByRole('button', { name: 'Settings' }).click();
  await dialog.getByRole('button', { name: 'AI and models' }).click();
  await expect(dialog.getByTestId('model-active')).toContainText('Codex · deep-model');
  await expect(dialog.getByLabel('Codex model')).toHaveValue('deep-model');
  await closeSettings();

  // It lasts: after a quit and a cold start the same model does the next turn.
  await quit();
  await launch(env);
  await page.getByRole('navigation').getByRole('button', { name: 'Native' }).click();
  await expect(composer()).toHaveAccessibleName(/Deep model/);
  expect(await say('Fourth')).toMatchObject({ status: 'done', work: { harness: expect.stringContaining('Codex · deep-model') } });
  expect(asked().at(-1)?.model).toBe('deep-model');
  expect((await api<{ id: string; name: string }[]>(page, 'material.list', { projectId: p.id })).some((m) => m.name === 'brief.md')).toBe(true);
  await quit();
});
