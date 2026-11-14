import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// Goals that run until met, branches and search, as a person meets them: /goal starts a run whose
// checks show in the chat and whose card ends with the evidence; a blocked goal waits in Needs you;
// a chat branches from any turn; search finds words in any chat. Pi on a scripted model.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel, type Message, type ScriptedModel, type Step } from '@backbone-next/platform/testing';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, stopBridge } from './bridge';
import { api } from './journey';

const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };
const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
const checks = new Map<string, string[]>();
function answering(messages: Message[]): Step {
  const asked = words(messages[messages.findLastIndex((m) => m.role === 'user')]);
  const goal = /completion criterion:\s*(.+)/.exec(asked)?.[1]?.trim();
  if (goal && /Goal check/.test(asked)) { const q = checks.get(goal) ?? ['NOT MET: more']; return { text: q.length > 1 ? q.shift()! : q[0] }; }
  if (/zebra/i.test(asked)) return { text: 'The zebra crossing memo is drafted.' };
  return { text: 'Worked on it.' };
}

let model: ScriptedModel;
test.beforeAll(async () => { model = await startScriptedModel('scripted-model', answering); });
test.afterAll(async () => { await model.close(); });

async function opened(page: Page, label: string) {
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  // An installed app creates its own encrypted vault; a prepared plaintext home must be refused.
  const home = installed ? mkdtempSync(join(tmpdir(), `backbone-${label}-`)) : freshDataHome(label);
  const env = { BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model };
  const app = installed ? await electron.launch({ executablePath: installed, args: [], env: { ...process.env, ...env, BACKBONE_HOME: home } }) : undefined;
  if (app) { expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true); page = await app.firstWindow(); }
  Object.assign(process.env, env);
  const bridge = app ? undefined : await startBridge(home);
  for (const name of Object.keys(env)) delete process.env[name];
  if (bridge) await page.goto(bridge.url);
  try { await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 }); }
  catch (error) { if (app) await app.close(); if (bridge) await stopBridge(bridge.proc); await removeDataHome(home); throw error; }
  const p = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Ops', kind: 'folder' });
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: 'Ops' }).click();
  return { page, projectId: p.value.id, end: async () => { if (app) await app.close(); if (bridge) await stopBridge(bridge.proc); await removeDataHome(home); } };
}

test('/goal runs until a check finds it met, and the card ends with the evidence', async ({ page: browserPage }) => {
  checks.set('Plan the launch with owners', ['NOT MET: no owners yet', 'MET: every step has an owner']);
  const { page, end } = await opened(browserPage, 'goal-met');
  try {
    await page.getByRole('textbox', { name: 'Message' }).fill('/goal Plan the launch with owners');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    const card = page.getByTestId('thread-goal');
    await expect(card).toContainText('Met', { timeout: TEST_HANG_MS });
    await expect(card).toContainText('every step has an owner');
    await expect(page.getByTestId('goal-check')).toHaveCount(2);
    await expect(page.getByTestId('goal-check').first()).toContainText('Not met');
    await expect(page.getByTestId('goal-check').first()).toContainText('no owners yet');
    await expect(card.getByRole('button', { name: 'Run until met' })).toBeVisible();
  } finally { await end(); }
});

test('a blocked goal waits in Needs you, one click from its chat', async ({ page: browserPage }) => {
  checks.set('Pick the venue', ['BLOCKED: choose Lisbon or Porto']);
  const { page, end } = await opened(browserPage, 'goal-blocked');
  try {
    await page.getByRole('textbox', { name: 'Message' }).fill('/goal Pick the venue');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.getByTestId('thread-goal')).toContainText('choose Lisbon or Porto', { timeout: TEST_HANG_MS });
    await expect(page.getByTestId('thread-goal').getByRole('button', { name: 'Resume' })).toBeVisible();
    await page.getByRole('button', { name: 'New chat', exact: false }).first().click();
    await page.getByRole('button', { name: /^Needs you/ }).click();
    const item = page.getByTestId('needs-you').getByTestId('goal-waiting');
    await expect(item).toContainText('choose Lisbon or Porto');
    await item.click();
    await expect(page.getByTestId('thread-goal')).toBeVisible();
  } finally { await end(); }
});

test('a chat branches from any turn, and search finds words in any chat', async ({ page: browserPage }) => {
  const { page, projectId, end } = await opened(browserPage, 'goal-branch');
  try {
    const a = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId, text: 'Draft the zebra crossing memo', attachments: [], settings, clientKey: 'a' });
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: a.value.threadId })).value.summary.running).toBe(false);
    await api(page, 'turns.send', { threadId: a.value.threadId, projectId, text: 'Now shorten it', attachments: [], settings, clientKey: 'b' });
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: a.value.threadId })).value.summary.running).toBe(false);
    await page.reload();
    await page.getByRole('navigation').getByText('Draft the zebra crossing memo').first().click();
    await expect(page.getByTestId('turn')).toHaveCount(2);
    await page.getByTestId('turn').first().getByRole('button', { name: 'Branch from here' }).click();
    await expect(page.getByTestId('forked-from')).toBeVisible();
    await expect(page.getByTestId('turn')).toHaveCount(1);

    await page.getByRole('button', { name: 'Search chats' }).click();
    await page.getByRole('combobox').fill('crossing memo drafted');
    const hit = page.getByTestId('search-hit').first();
    await expect(hit).toContainText('zebra crossing memo is drafted');
    await hit.click();
    await expect(page.getByTestId('turn').first()).toBeVisible();
  } finally { await end(); }
});

test('a person sets a token budget, sees usage, and the goal stops before another turn', async ({ page: browserPage }) => {
  const { page, projectId, end } = await opened(browserPage, 'goal-tokens');
  try {
    const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId, text: 'Prepare a bounded plan', attachments: [], settings, clientKey: 'bounded' });
    const threadId = sent.value.threadId;
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: threadId })).value.summary.running).toBe(false);
    await api(page, 'goals.set', { threadId, text: 'Plan within an allowance', baseVersion: 0 });
    await page.reload();
    await page.getByRole('navigation').getByText('Prepare a bounded plan').first().click();
    const card = page.getByTestId('thread-goal');
    await card.getByRole('spinbutton', { name: 'Token budget' }).fill('1');
    await card.getByRole('button', { name: 'Run until met' }).click();
    await expect(card).toContainText(/Token budget reached/i, { timeout: 30_000 });
    await expect(card.getByTestId('goal-token-usage')).toContainText(/\d+ of 1 tokens/);
    await expect(card.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    const t = await api<{ value: { turns: unknown[] } }>(page, 'threads.get', { id: threadId });
    expect(t.value.turns).toHaveLength(2);
  } finally { await end(); }
});

test('a person attaches a rubric and a premature MET waits for every criterion to pass', async ({ page: browserPage }) => {
  const goal = 'Plan with checked owners and dates';
  checks.set(goal, ['MET: ready\nPASS 1: owners present\nFAIL 2: no dates', 'MET: ready\nPASS 1: owners present\nPASS 2: dates present']);
  const { page, projectId, end } = await opened(browserPage, 'goal-rubric');
  try {
    const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId, text: 'Prepare a checked plan', attachments: [], settings, clientKey: 'rubric' });
    const threadId = sent.value.threadId;
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: threadId })).value.summary.running).toBe(false);
    await api(page, 'goals.set', { threadId, text: goal, baseVersion: 0 });
    await page.reload();
    await page.getByRole('navigation').getByText('Prepare a checked plan').first().click();
    const card = page.getByTestId('thread-goal');
    await card.getByRole('textbox', { name: 'Completion rubric' }).fill('Every step has an owner\nEvery step has a date');
    await card.getByRole('button', { name: 'Run until met' }).click();
    await expect(card).toContainText('Met:', { timeout: 30_000 });
    await expect(page.getByTestId('goal-check')).toHaveCount(2);
    await expect(page.getByTestId('goal-check').first()).toContainText(/Not met/i);
    await expect(card.getByTestId('goal-rubric-result')).toHaveCount(2);
    for (const result of await card.getByTestId('goal-rubric-result').all()) await expect(result).toContainText(/^Pass:/);
    await page.reload();
    await expect(card.getByTestId('goal-rubric-result').last()).toContainText('dates present');
  } finally { await end(); }
});
