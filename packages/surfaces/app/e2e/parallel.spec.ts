// Goals, child threads and forks as a person meets them, on the browser bridge with the stub model.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel, scriptedStep, type Message, type ScriptedModel, type Step } from '@backbone-next/platform/testing';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, stopBridge } from './bridge';
import { api } from './journey';

const settings = { permission: 'ask', model: 'stub', effort: 2, runsOn: 'this-computer', mode: 'chat' };

/** A real engine on a scripted model: "Hold on" turns keep listing files until `holding` ends. */
let holding = false;
const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
function stepped(messages: Message[]): Step {
  const start = messages.findIndex((m) => m.role === 'user' && /Hold on/.test(words(m)));
  if (start < 0) return scriptedStep(messages);
  return holding ? { calls: [{ name: 'list_files', args: {} }] } : { text: 'Finished holding.' };
}

async function chat(page: Page, label: string, engine?: ScriptedModel) {
  const home = freshDataHome(label);
  const env = engine ? { BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: engine.url, BACKBONE_MODEL_ID: engine.model } : {};
  Object.assign(process.env, env);
  const bridge = await startBridge(home);
  for (const name of Object.keys(env)) delete process.env[name];
  await page.goto(bridge.url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  const p = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Launch', kind: 'folder' });
  const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId: p.value.id, text: 'Hello', attachments: [], settings, clientKey: 'first' });
  const threadId = sent.value.threadId;
  await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: threadId })).value.summary.running).toBe(false);
  await page.reload();
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Launch' }).click();
  await page.getByRole('navigation').getByText('Hello').first().click();
  await expect(page.getByTestId('turn').first()).toBeVisible();
  return { threadId, projectId: p.value.id, end: async () => { await stopBridge(bridge.proc); await removeDataHome(home); } };
}
const send = (page: Page, text: string) => page.getByRole('textbox', { name: 'Message' }).fill(text);
/** A turn left open on the engine, shown as running in the composer. */
async function hold(page: Page, threadId: string, projectId: string) {
  holding = true;
  await api(page, 'turns.send', { threadId, projectId, text: 'Hold on', attachments: [], settings, clientKey: 'hold' });
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
}
const details = (page: Page) => page.getByRole('button', { name: 'Chat details' }).click();

test('typing /goal sets the goal and starts work on it; its card changes and clears it', async ({ page }) => {
  const { end } = await chat(page, 'goal-slash');
  try {
    await send(page, '/goal Ship the launch plan');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    const card = page.getByTestId('thread-goal');
    await expect(card).toContainText('Ship the launch plan');
    // The goal's words start a turn of work; its check can follow at once, so no turn's place is assumed.
    await expect(page.getByTestId('turn').filter({ hasText: 'Ship the launch plan' }).first()).toBeVisible();
    await expect(page.getByTestId('turn').filter({ hasText: '/goal' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    await card.getByRole('button', { name: 'Change goal' }).click();
    await expect(page.getByRole('dialog', { name: 'Goal' }).getByRole('textbox', { name: 'Goal' })).toHaveValue('Ship the launch plan');
    await page.keyboard.press('Escape');
    await card.getByRole('button', { name: 'Clear goal' }).click();
    await expect(page.getByTestId('thread-goal')).toHaveCount(0);
  } finally { await end(); }
});

test('the composer offers a goal, written as /goal', async ({ page }) => {
  const { end } = await chat(page, 'goal-menu');
  try {
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Set a goal' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('/goal ');
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
  } finally { await end(); }
});

test('a person sets, changes and clears a goal, and it stays visible on the thread', async ({ page }) => {
  const { end } = await chat(page, 'goal-set');
  try {
    await details(page);
    await page.getByRole('menuitem', { name: 'Set goal…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Goal' });
    await dialog.getByRole('textbox', { name: 'Goal' }).fill('Ship the launch plan');
    await dialog.getByRole('button', { name: 'Save goal' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('thread-goal')).toContainText('Ship the launch plan');
    await details(page);
    await page.getByRole('menuitem', { name: 'Change goal…' }).click();
    await expect(page.getByRole('textbox', { name: 'Goal' })).toHaveValue('Ship the launch plan');
    await page.getByRole('textbox', { name: 'Goal' }).fill('Ship it on Monday');
    await page.getByRole('button', { name: 'Save goal' }).click();
    await expect(page.getByTestId('thread-goal')).toContainText('Ship it on Monday');
    await details(page);
    await page.getByRole('menuitem', { name: 'Clear goal' }).click();
    await expect(page.getByTestId('thread-goal')).toBeHidden();
  } finally { await end(); }
});

test('an agent\'s proposed goal waits for the person and changes nothing until accepted', async ({ page }) => {
  const { threadId, end } = await chat(page, 'goal-proposal');
  try {
    const decided: unknown[] = [];
    await page.route('**/api', async (route) => {
      const { method, args } = route.request().postDataJSON();
      if (method === 'goals.decide') { decided.push(args); return route.fulfill({ json: { ok: false, reason: 'STALE_BASE', detail: 'The goal changed.' } }); }
      if (method !== 'threads.get') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.value.goal = { current: null, version: 3, history: [], proposals: [{ id: 'p1', text: 'Cut scope', by: 'agent', threadId, turnId: 't', at: new Date().toISOString(), state: 'open' }] };
      return route.fulfill({ response, json: body });
    });
    await page.getByRole('navigation').getByText('Hello').first().click();
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Launch' }).click();
    await page.getByRole('navigation').getByText('Hello').first().click();
    const proposal = page.getByTestId('goal-proposal');
    await expect(proposal).toContainText('Cut scope');
    await expect(page.getByTestId('thread-goal')).toBeHidden();
    await proposal.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => decided).toEqual([expect.objectContaining({ threadId, proposalId: 'p1', verdict: 'accept', baseVersion: 3 })]);
    await expect(page.getByRole('alert')).toContainText('The goal changed.');
  } finally { await end(); }
});

test('a person starts a child and a reviewer, follows them and returns to the parent', async ({ page }) => {
  const { threadId, end } = await chat(page, 'children');
  try {
    await details(page);
    await page.getByRole('menuitem', { name: 'Start a worker…' }).click();
    await page.getByRole('textbox', { name: 'What should it do?' }).fill('Draft the risks');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const row = page.getByTestId('child-row').filter({ hasText: 'Draft the risks' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Worker');
    await expect(row.getByTestId('child-not-enforced')).toContainText(/Not enforced:.*permission.*token budget/);
    await details(page);
    await page.getByRole('menuitem', { name: 'Ask for a review…' }).click();
    await page.getByRole('textbox', { name: 'What should it check?' }).fill('Check the risks');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.getByTestId('child-row').filter({ hasText: 'Check the risks' })).toContainText('Reviewer');
    await expect.poll(async () => (await api<{ value: { card: { subagents: { active: number; done: number } } } }>(page, 'threads.get', { id: threadId })).value.card.subagents.done).toBe(2);
    await row.getByRole('button').first().click();
    const back = page.getByTestId('child-of');
    await expect(back).toContainText('Hello');
    await expect(page.getByRole('button', { name: 'Chat details' })).toBeVisible();
    await details(page);
    await expect(page.getByRole('menuitem', { name: /Start a worker/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await back.getByRole('button').click();
    await expect(page.getByTestId('child-row').first()).toBeVisible();
  } finally { await end(); }
});

test('a message typed while a turn runs waits, can be changed or removed, survives a reload and goes once', async ({ page }) => {
  const model = await startScriptedModel('scripted-model', stepped);
  const { threadId, projectId, end } = await chat(page, 'queue', model);
  try {
    await hold(page, threadId, projectId);
    await send(page, 'First thought');
    await page.getByRole('button', { name: 'Send when done' }).click();
    const rows = page.getByTestId('queued-message');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('First thought');
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    await send(page, 'Second thought');
    await page.keyboard.press('Enter');
    await expect(rows).toHaveCount(2);
    await rows.first().getByRole('button', { name: 'Edit' }).click();
    await rows.first().getByRole('textbox', { name: 'Queued message' }).fill('First, changed');
    await rows.first().getByRole('button', { name: 'Save' }).click();
    await expect(rows.first()).toContainText('First, changed');
    await rows.nth(1).getByRole('button', { name: 'Remove' }).click();
    await expect(rows).toHaveCount(1);
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await expect(page.getByTestId('queued-message')).toContainText('First, changed');
    holding = false;
    await expect(page.getByTestId('queued-message')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Transcript' })).toContainText('First, changed');
    await expect.poll(async () => (await api<{ value: { turns: { user: { text: string } }[] } }>(page, 'threads.get', { id: threadId })).value.turns.filter((t) => t.user.text === 'First, changed').length).toBe(1);
  } finally { holding = false; await end(); await model.close(); }
});

test('a queued message whose answer was lost is the same message when tried again', async ({ page }) => {
  const model = await startScriptedModel('scripted-model', stepped);
  const { threadId, projectId, end } = await chat(page, 'queue-retry', model);
  try {
    await hold(page, threadId, projectId);
    let lost = 0;
    await page.route('**/api', async (route) => {
      const { method } = route.request().postDataJSON();
      if (method === 'queue.add' && lost++ === 0) { await route.fetch(); return route.abort(); }
      return route.continue();
    });
    await send(page, 'Only once');
    await page.getByRole('button', { name: 'Send when done' }).click();
    await expect(page.getByRole('alert')).toContainText('could not be confirmed');
    await page.getByRole('button', { name: 'Send when done' }).click();
    await expect(page.getByTestId('queued-message')).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    // Changed words are a new message: they are not swallowed by the one that may have landed.
    lost = 0;
    await send(page, 'Second words');
    await page.getByRole('button', { name: 'Send when done' }).click();
    await expect(page.getByRole('alert')).toContainText('could not be confirmed');
    await send(page, 'Second words, changed');
    await page.getByRole('button', { name: 'Send when done' }).click();
    await expect(page.getByTestId('queued-message').filter({ hasText: 'Second words, changed' })).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  } finally { holding = false; await end(); await model.close(); }
});

test('Stop holds what is waiting until the person sends it', async ({ page }) => {
  const model = await startScriptedModel('scripted-model', stepped);
  const { threadId, projectId, end } = await chat(page, 'queue-stop', model);
  try {
    await hold(page, threadId, projectId);
    await send(page, 'After the stop');
    await page.getByRole('button', { name: 'Send when done' }).click();
    await expect(page.getByTestId('queued-message')).toHaveCount(1);
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByTestId('queue-held')).toContainText('stopped');
    await expect(page.getByTestId('queued-message')).toHaveCount(1);
    holding = false;
    await page.getByRole('button', { name: 'Send now' }).click();
    await expect(page.getByTestId('queued-message')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Transcript' })).toContainText('After the stop');
  } finally { holding = false; await end(); await model.close(); }
});

test('Enter after Stop stays a draft until the turn has ended, then goes as a send; changing the words calls it off', async ({ page }) => {
  const model = await startScriptedModel('scripted-model', stepped);
  const { threadId, projectId, end } = await chat(page, 'after-stop', model);
  try {
    await hold(page, threadId, projectId);
    // The turn is kept looking open, as it does for a moment after Stop while its last write settles.
    let open = true;
    await page.route('**/api', async (route) => {
      const { method } = route.request().postDataJSON();
      if (method !== 'threads.get' || !open) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.value.summary.running = true;
      return route.fulfill({ response, json: body });
    });
    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, 'Changed my mind');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('after-stop')).toBeVisible();
    await send(page, 'Second thoughts');
    await expect(page.getByTestId('after-stop')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('after-stop')).toBeVisible();
    await expect(page.getByTestId('queued-message')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Second thoughts');
    holding = false;
    open = false;
    await api(page, 'threads.update', { id: threadId, patch: { pinned: true } });
    await expect(page.getByRole('list', { name: 'Transcript' })).toContainText('Second thoughts');
    await expect(page.getByTestId('queued-message')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  } finally { holding = false; await end(); await model.close(); }
});

test('words waiting for a Stop stay with their chat when the person moves to another', async ({ page }) => {
  const model = await startScriptedModel('scripted-model', stepped);
  const { threadId, projectId, end } = await chat(page, 'after-stop-switch', model);
  try {
    const other = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId, text: 'Another chat', attachments: [], settings, clientKey: 'other' });
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: other.value.threadId })).value.summary.running).toBe(false);
    await hold(page, threadId, projectId);
    await page.route('**/api', async (route) => {
      const { method, args } = route.request().postDataJSON();
      if (method !== 'threads.get' || args.id !== threadId) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.value.summary.running = true;
      return route.fulfill({ response, json: body });
    });
    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, 'For the first chat');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('after-stop')).toBeVisible();
    await page.getByRole('navigation').getByText('Another chat').first().click();
    await expect(page.getByRole('heading', { name: 'Another chat' })).toBeAttached();
    await page.waitForTimeout(300);
    const t = await api<{ value: { turns: { user: { text: string } }[] } }>(page, 'threads.get', { id: other.value.threadId });
    expect(t.value.turns.map((x) => x.user.text)).toEqual(['Another chat']);
  } finally { holding = false; await end(); await model.close(); }
});

test('a send whose answer was lost is the same turn when tried again', async ({ page }) => {
  const { threadId, end } = await chat(page, 'send-retry');
  try {
    let lost = 0;
    await page.route('**/api', async (route) => {
      const { method } = route.request().postDataJSON();
      if (method === 'turns.send' && lost++ === 0) { await route.fetch(); return route.abort(); }
      return route.continue();
    });
    await send(page, 'Only one turn');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('could not finish sending');
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: threadId })).value.summary.running).toBe(false);
    // The key lives with the draft, so a reload does not make the same words a new message.
    await expect.poll(async () => (await api<{ meta?: { sendKey?: string } } | null>(page, 'drafts.get', { key: `composer:${threadId}` }))?.meta?.sendKey).toBeTruthy();
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Only one turn');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    const t = await api<{ value: { turns: { user: { text: string } }[] } }>(page, 'threads.get', { id: threadId });
    expect(t.value.turns.filter((x) => x.user.text === 'Only one turn').length).toBe(1);
  } finally { await end(); }
});

test('words steered at a running turn say only what the engine confirmed', async ({ page }) => {
  const model = await startScriptedModel('scripted-model', stepped);
  const { threadId, projectId, end } = await chat(page, 'steer', model);
  try {
    await hold(page, threadId, projectId);
    await send(page, 'Use the blue one');
    await page.getByRole('button', { name: 'Steer' }).click();
    const steer = page.getByTestId('turn-steer');
    await expect(steer).toContainText('Use the blue one');
    await expect(steer).toContainText('Reached the turn');
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    holding = false;
  } finally { holding = false; await end(); await model.close(); }
});

test('an unconfirmed steer is never shown as delivered, and an engine that cannot steer says so', async ({ page }) => {
  const { threadId, end } = await chat(page, 'no-steer');
  try {
    await page.route('**/api', async (route) => {
      const { method } = route.request().postDataJSON();
      if (method !== 'threads.get') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.value.summary.running = true;
      body.value.turns.at(-1).steers = [{ id: 's', text: 'Did you get this', at: new Date().toISOString(), state: 'unknown', detail: 'The engine gave no answer.' }];
      return route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Launch' }).click();
    await page.getByRole('navigation').getByText('Hello').first().click();
    const steer = page.getByTestId('turn-steer');
    await expect(steer).toContainText('Not confirmed');
    await expect(steer).not.toContainText('Reached');
    await send(page, 'Something more');
    await expect(page.getByRole('button', { name: 'Send when done' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Steer' })).toHaveCount(0);
    await expect(page.getByTestId('no-steer')).toContainText('cannot take a message');
    expect(threadId).toBeTruthy();
  } finally { await end(); }
});

test('a worker\'s document comes back one at a time, and a person\'s edit stands', async ({ page }) => {
  const { threadId, end } = await chat(page, 'merge');
  try {
    await details(page);
    await page.getByRole('menuitem', { name: 'Start a worker…' }).click();
    await page.getByRole('textbox', { name: 'What should it do?' }).fill('Write an editable brief');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const doc = page.getByTestId('child-document');
    await expect(doc).toContainText('brief.md');
    const bring = doc.getByRole('button', { name: 'Bring back' });
    await expect(bring).toBeVisible();
    const parent = await api<{ value: { children: { documents: { materialId: string; current: number }[] }[] } }>(page, 'threads.get', { id: threadId });
    const { materialId, current } = parent.value.children[0].documents[0];
    await api(page, 'material.save', { id: materialId, text: 'Mine', baseVersion: current });
    await expect(doc).toContainText('lands beside');
    await doc.getByRole('button', { name: 'Keep beside yours' }).click();
    await expect(doc).toContainText('Brought back');
    await expect(page.getByTestId('turn-merge')).toContainText('brief (revision of v1).md');
    const read = await api<{ value: { text: string } }>(page, 'material.read', { id: materialId });
    expect(read.value.text).toBe('Mine');
  } finally { await end(); }
});

test('a document that cannot come back says why and offers nothing', async ({ page }) => {
  const { end } = await chat(page, 'merge-blocked');
  try {
    await page.route('**/api', async (route) => {
      const { method } = route.request().postDataJSON();
      if (method !== 'threads.get') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.value.children = [{ threadId: 'c', title: 'Worker', role: 'worker', startedBy: 'person', settings, running: false, unknown: 1, documents: [{ materialId: 'm', name: 'plan.md', version: 1, current: 1, by: 'agent', state: 'blocked', detail: 'This worker has an outcome that is UNKNOWN.' }] }];
      return route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Launch' }).click();
    await page.getByRole('navigation').getByText('Hello').first().click();
    const doc = page.getByTestId('child-document');
    await expect(doc).toContainText('UNKNOWN');
    await expect(doc.getByRole('button')).toHaveCount(0);
  } finally { await end(); }
});

test('asking for a review where none can run explains why before anything is typed', async ({ page }) => {
  const { end } = await chat(page, 'native-review');
  try {
    await page.route('**/api', async (route) => {
      const { method } = route.request().postDataJSON();
      if (method !== 'threads.get') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.value.reviewer = { available: false, detail: 'A review cannot run here. This engine works at full access in its own staging.' };
      return route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Launch' }).click();
    await page.getByRole('navigation').getByText('Hello').first().click();
    await details(page);
    await page.getByRole('menuitem', { name: 'Ask for a review…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ask for a review' });
    await expect(dialog.getByTestId('reviewer-unavailable')).toContainText('cannot run here');
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
  } finally { await end(); }
});

test('forking a chat from the sidebar opens the fork', async ({ page }) => {
  const { end } = await chat(page, 'fork');
  try {
    await page.getByRole('navigation').getByText('Hello').first().hover();
    await page.getByRole('navigation').getByRole('button', { name: /^Actions|Chat actions|Thread actions/ }).first().click();
    await page.getByRole('menuitem', { name: 'Fork' }).click();
    await expect(page.getByTestId('fork-role-notice')).toBeVisible();
    await page.getByRole('menuitem', { name: 'As a chat' }).click();
    await expect(page.getByTestId('forked-from')).toContainText('Hello');
  } finally { await end(); }
});

test('a running turn shows its work as it happens, and folds it once the turn ends', async ({ page }) => {
  const model = await startScriptedModel('scripted-model', stepped);
  const { threadId, projectId, end } = await chat(page, 'work-live', model);
  try {
    await hold(page, threadId, projectId);
    const work = page.getByTestId('work-block').last();
    await expect(work).toHaveText(/Working/);
    await expect(work).toHaveAttribute('aria-expanded', 'true');
    // The person can still fold it while it runs; the latest step then stays in view beside "Working…".
    await work.click();
    await expect(work).toHaveAttribute('aria-expanded', 'false');
    await work.click();
    holding = false;
    await expect(work).toHaveText(/Worked for/);
    // Opened by the person, it stays open; a turn nobody touched folds when it ends.
    await expect(work).toHaveAttribute('aria-expanded', 'true');
  } finally { holding = false; await end(); await model.close(); }
});
