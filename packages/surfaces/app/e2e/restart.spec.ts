import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// A goal run across a crash, as a person meets it: the app is killed while the run works, and opened
// again on the same home. A turn cut short in its model call is carried on and the run goes on to Met;
// one cut short in a write says the app stopped, keeps the write UNKNOWN, resends nothing, and waits
// with a Resume. Pi on a scripted model, and the stand-in engine for the write.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel, type Message, type ScriptedModel, type Step } from '@backbone-next/platform/testing';
import { expect, test, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { startBridge } from './bridge';
import { api } from './journey';

const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
function answering(messages: Message[]): Step {
  const asked = words(messages[messages.findLastIndex((m) => m.role === 'user')]);
  if (/Goal check/.test(asked)) return { text: 'MET: the outline names every step' };
  return { text: 'Outlined the launch.' };
}

/** The goal's first turn of work is held until the app is killed. */
let workCalls = 0;
let reached: () => void = () => {};
const reachedWork = new Promise<void>((r) => (reached = r));
let model: ScriptedModel;
test.beforeAll(async () => {
  model = await startScriptedModel('scripted-model', answering, {
    async before(messages) {
      if (!/Outline the launch/.test(words(messages[messages.findLastIndex((m) => m.role === 'user')]))) return;
      if (++workCalls === 1) { reached(); await new Promise(() => {}); }
    },
  });
});
test.afterAll(async () => { await model.close(); });

async function bridge(home: string, env: Record<string, string>) {
  Object.assign(process.env, env);
  try { return await startBridge(home); } finally { for (const name of Object.keys(env)) delete process.env[name]; }
}
async function show(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
}
const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };
const exited = (proc: ChildProcess) => new Promise<void>((resolve) => { if (proc.exitCode !== null || proc.signalCode) resolve(); else proc.once('exit', () => resolve()); });

/** Stop a bridge that may already have ended. */
async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode) return;
  proc.kill('SIGTERM');
  await exited(proc);
}
async function project(page: Page) {
  const p = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Launch', kind: 'folder' });
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: /^Launch/ }).click();
  return p.value.id;
}
const goalCard = (page: Page) => page.getByTestId('thread-goal');
async function openChat(page: Page) {
  await page.getByRole('navigation').getByRole('button', { name: /^Launch/ }).click();
  const [thread] = await api<{ id: string; title: string }[]>(page, 'threads.list', {});
  await page.getByRole('navigation').getByText(thread.title, { exact: true }).first().click();
  return thread.id;
}

test('killed while a goal works, the app carries the turn on when it opens again, and the goal is met', async ({ page }) => {
  const home = freshDataHome('restart-resumed');
  const env = { BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model };
  let first = await bridge(home, env);
  try {
    await show(page, first.url);
    await project(page);
    await page.getByRole('textbox', { name: 'Message' }).fill('/goal Outline the launch');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(goalCard(page)).toContainText('Working toward it');
    await reachedWork;
    first.proc.kill('SIGKILL');
    await exited(first.proc);
    first = await bridge(home, env);
    await show(page, first.url);
    const threadId = await openChat(page);
    await expect(goalCard(page)).toContainText('Met: the outline names every step', { timeout: TEST_HANG_MS });
    const t = await api<{ value: { turns: { user: { text: string }; interrupted?: boolean; status: string }[] } }>(page, 'threads.get', { id: threadId });
    const work = t.value.turns.filter((x) => x.user.text === 'Outline the launch');
    expect(work.map((x) => [x.interrupted, x.status])).toEqual([[true, 'done']]);
  } finally {
    await stop(first.proc);
    await removeDataHome(home);
  }
});

test('killed during a goal\'s write, the app says it was interrupted, resends nothing, and waits for the person', async ({ page }) => {
  const home = freshDataHome('restart-interrupted');
  let current = await bridge(home, { BACKBONE_HARNESS: 'harness-stub', BACKBONE_CRASH_AT: 'write.begun' });
  try {
    await show(page, current.url);
    const projectId = await project(page);
    const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId, text: 'Hello', attachments: [], settings, clientKey: 'hello' });
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: sent.value.threadId })).value.summary.running).toBe(false);
    await api(page, 'goals.set', { threadId: sent.value.threadId, text: 'Write an editable brief for the launch', baseVersion: 0 });
    // Its first turn of work writes; the app kills itself as the write begins.
    void api(page, 'goals.run', { threadId: sent.value.threadId, budget: 3 }).catch(() => {});
    await exited(current.proc);
    current = await bridge(home, { BACKBONE_HARNESS: 'harness-stub' });
    await show(page, current.url);
    const threadId = await openChat(page);
    await expect(goalCard(page)).toContainText('Interrupted: The app stopped during this goal\'s turn of work. A write\'s outcome is UNKNOWN; it was not resent.', { timeout: TEST_HANG_MS });
    await expect(page.getByTestId('effect-UNKNOWN')).toContainText('brief.md');
    await page.getByRole('button', { name: /^Needs you/ }).click();
    await expect(page.getByTestId('needs-you').getByTestId('goal-waiting')).toContainText('interrupted when the app stopped');
    await page.keyboard.press('Escape');
    await goalCard(page).getByRole('button', { name: 'Resume' }).click();
    await expect(goalCard(page)).toContainText('Waiting for you: A write\'s outcome is unknown');
    const t = await api<{ value: { turns: unknown[] } }>(page, 'threads.get', { id: threadId });
    expect(t.value.turns).toHaveLength(2);
    const files = await api<{ name: string }[]>(page, 'material.list', { projectId });
    expect(files.filter((f) => f.name === 'brief.md').length).toBeLessThanOrEqual(1);
  } finally {
    await stop(current.proc);
    await removeDataHome(home);
  }
});
