// The same controls run through development Electron and the freshly installed executable.
// Every model, home and person folder belongs to this test; no provider is contacted.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel, type Message } from '@backbone-next/platform/testing';
import type { Receipt, Thread } from '@backbone-next/platform';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, appDir } from './journey';

const value = <T>(receipt: Receipt<T>) => { if (!receipt.ok) throw new Error(`${receipt.reason}: ${receipt.detail}`); return receipt.value; };
const words = (message?: Message) => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(part => part.text ?? '').join('');
const read = async (page: Page, id: string) => value(await api<Receipt<Thread>>(page, 'threads.get', { id }));
const settings = { permission: 'full', model: 'scripted', effort: 3, runsOn: 'this-computer', mode: 'chat' };
function fixture() {
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  const home = installed ? mkdtempSync(join(tmpdir(), 'backbone-thread-control-installed-')) : freshDataHome('thread-control');
  const person = mkdtempSync(join(tmpdir(), 'backbone-thread-control-person-'));
  let app: ElectronApplication | undefined;
  return {
    async launch(env: Record<string, string>) {
      const supplied = { ...process.env, BACKBONE_CODEX_MODEL: undefined, BACKBONE_MODEL_ENDPOINT: undefined, BACKBONE_MODEL_ID: undefined,
        BACKBONE_CRASH_AT: undefined, ...env, BACKBONE_HOME: home, BACKBONE_USER_HOME: person };
      const clean = Object.fromEntries(Object.entries(supplied).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      app = await electron.launch(installed ? { executablePath: installed, args: [], env: clean } : { args: [appDir], env: clean });
      expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
      const page = await app.firstWindow();
      await expect(page.locator('[data-ready=true]')).toBeVisible();
      return page;
    },
    async crash() {
      const proc = app!.process();
      const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
      proc.kill('SIGKILL'); await exited; app = undefined;
    },
    async waitForCrash() {
      const proc = app!.process();
      if (proc.exitCode === null && !proc.signalCode) await new Promise<void>(resolve => proc.once('exit', () => resolve()));
      expect(proc.signalCode).toBe('SIGKILL'); app = undefined;
    },
    async cleanup() { await app?.close(); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); },
  };
}
async function createChat(page: Page) {
  const project = value(await api<Receipt<{ id: string }>>(page, 'projects.create', { name: 'Control work', kind: 'folder' }));
  const sent = value(await api<Receipt<{ threadId: string }>>(page, 'turns.send', { projectId: project.id, text: 'Ready to work', attachments: [], settings, clientKey: 'ready' }));
  await expect.poll(async () => (await read(page, sent.threadId)).summary.running).toBe(false);
  await openChat(page);
  return { projectId: project.id, threadId: sent.threadId };
}
async function openChat(page: Page) {
  await page.reload();
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  const project = page.getByRole('navigation').getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Control work/ }) });
  await project.getByRole('button', { name: 'Show its chats', exact: true }).click();
  await project.getByText('Ready to work', { exact: true }).first().click();
}

async function setGoal(page: Page, text: string) {
  await page.getByRole('button', { name: 'Chat details', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Set goal…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Goal', exact: true });
  await dialog.getByRole('textbox', { name: 'Goal', exact: true }).fill(text);
  await dialog.getByRole('button', { name: 'Save goal', exact: true }).click();
  await expect(page.getByTestId('thread-goal')).toContainText(text);
}

test('a person restarts a stuck conversation from its menu without replaying its write or losing history', async () => {
  const script = mkdtempSync(join(tmpdir(), 'backbone-thread-restart-script-'));
  for (const dir of ['plans', 'held', 'release']) mkdirSync(join(script, dir));
  const plan = (text: string, body: unknown) => writeFileSync(join(script, 'plans', `${createHash('sha256').update(text).digest('hex')}.json`), JSON.stringify(body));
  plan('Ready to work', { answer: 'Ready.' });
  plan('Hold the next write', { write: { title: 'must-not-land.md', content: 'Do not replay this write.' }, hold: 'original', answer: 'Should not finish.' });
  plan('Continue this conversation from its recorded progress. Inspect completed work before doing more. Do not repeat any action whose outcome is unknown.', { answer: 'Continued from recorded progress.' });
  const f = fixture();
  try {
    const page = await f.launch({ BACKBONE_HARNESS: 'scripted', BACKBONE_SCRIPT_DIR: script });
    const { threadId, projectId } = await createChat(page);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Hold the next write'); await composer.press('Enter');
    await expect.poll(() => existsSync(join(script, 'held', 'original'))).toBe(true);
    const original = (await read(page, threadId)).turns.at(-1)!;
    await page.getByRole('button', { name: 'Chat details', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Restart conversation', exact: true }).click();
    await expect(page.getByTestId('answer').last()).toContainText('Continued from recorded progress.');
    await expect.poll(async () => (await read(page, threadId)).summary.running).toBe(false);
    const thread = await read(page, threadId);
    expect(thread.turns.map(turn => turn.status)).toEqual(['done', 'stopped', 'done']);
    expect(thread.turns[0].user.text).toBe('Ready to work');
    expect(thread.turns[2].restartOf).toBe(original.id);
    expect(thread.turns[2].user.text).not.toBe(original.user.text);
    expect(await api<{ name: string }[]>(page, 'material.list', { projectId })).toEqual([]);
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    expect((await read(page, threadId)).turns).toHaveLength(3);
  } finally { await f.cleanup(); rmSync(script, { recursive: true, force: true }); }
});

test('a person steers the same running turn and queues follow-ups visibly when the engine cannot steer', async () => {
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let blocked = false;
  const model = await startScriptedModel('thread-steering', messages => {
    if (messages.some(message => message.role === 'user' && words(message).includes('Use the blue plan'))) return { text: 'Using the blue plan in this turn.' };
    return words(messages.findLast(message => message.role === 'user')).includes('Keep working') ? { calls: [{ name: 'list_files', args: {} }] } : { text: 'Ready.' };
  }, { async before(messages) { if (!blocked && words(messages.findLast(message => message.role === 'user')).includes('Keep working')) { blocked = true; reached(); await held; } } });
  const f = fixture();
  let script: string | undefined;
  try {
    let page = await f.launch({ BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model });
    const { threadId } = await createChat(page);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Keep working'); await composer.press('Enter'); await started;
    await composer.fill('Use the blue plan');
    await page.getByTestId('composer').getByRole('button', { name: 'Steer', exact: true }).click();
    release();
    await expect.poll(async () => (await read(page, threadId)).turns.at(-1)?.steers?.at(-1)?.state).toBe('delivered');
    await expect(page.getByTestId('turn-steer')).toContainText('Use the blue plan');
    await expect(page.getByTestId('answer').last()).toContainText('blue plan');
    const steered = await read(page, threadId);
    expect(steered.turns).toHaveLength(2);
    expect(steered.turns[1].steers?.map(item => item.state)).toEqual(['delivered']);
    expect(steered.queue ?? []).toHaveLength(0);
    await expect.poll(async () => (await read(page, threadId)).summary.running).toBe(false);
    await f.crash();
    // The existing scripted engine holds before the write, outside the data-folder
    // lock, until this test releases it. Queue visibility cannot race a timer.
    script = mkdtempSync(join(tmpdir(), 'backbone-thread-control-script-'));
    for (const dir of ['plans', 'held', 'release']) mkdirSync(join(script, dir));
    const plan = (text: string, body: unknown) => writeFileSync(join(script!, 'plans', `${createHash('sha256').update(text).digest('hex')}.json`), JSON.stringify(body));
    plan('Write an editable brief', { write: { title: 'brief.md', content: 'The controlled brief.' }, hold: 'queued', answer: 'The brief is ready.' });
    plan('Then inspect the result', { answer: 'Inspected the recorded result.' });
    page = await f.launch({ BACKBONE_HARNESS: 'scripted', BACKBONE_SCRIPT_DIR: script });
    await openChat(page);
    const next = page.getByRole('textbox', { name: 'Message', exact: true });
    await next.fill('Write an editable brief'); await next.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect.poll(() => existsSync(join(script!, 'held', 'queued'))).toBe(true);
    await next.fill('Then inspect the result');
    await expect(page.getByTestId('no-steer')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Steer', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Send when done', exact: true }).click();
    await expect(page.getByTestId('queued-message')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await expect(page.getByTestId('queued-message')).toHaveCount(1);
    writeFileSync(join(script, 'release', 'queued'), '');
    await expect.poll(async () => (await read(page, threadId)).turns.filter(turn => turn.user.text === 'Then inspect the result').length).toBe(1);
    await expect.poll(async () => (await read(page, threadId)).summary.running).toBe(false);
    await expect(page.getByTestId('queued-message')).toHaveCount(0);
    await page.reload();
    expect((await read(page, threadId)).turns.filter(turn => turn.user.text === 'Then inspect the result')).toHaveLength(1);
  } finally { release(); await f.cleanup(); await model.close(); if (script) rmSync(script, { recursive: true, force: true }); }
});

test('a person reopens an interrupted goal with its original history and sees it complete', async () => {
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const model = await startScriptedModel('thread-restart', messages => {
    const text = words(messages.findLast(message => message.role === 'user'));
    return { text: text.includes('Goal check') ? 'MET: the launch outline is complete' : 'Outlined the launch.' };
  }, { async before(messages) { if (words(messages.findLast(message => message.role === 'user')).includes('Outline the launch') && ++calls === 1) { reached(); await held; } } });
  const f = fixture();
  const env = { BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model };
  try {
    let page = await f.launch(env);
    const { threadId } = await createChat(page);
    await setGoal(page, 'Outline the launch');
    await page.getByTestId('thread-goal').getByRole('button', { name: 'Run until met', exact: true }).click();
    await started;
    await expect.poll(async () => (await read(page, threadId)).goalRun?.status).toBe('running');
    await f.crash(); release();
    page = await f.launch(env); await openChat(page);
    await expect.poll(async () => (await read(page, threadId)).goalRun?.status).toBe('met');
    await expect(page.getByTestId('thread-goal')).toContainText('the launch outline is complete');
    const thread = await read(page, threadId);
    expect(thread.turns[0].user.text).toBe('Ready to work');
    expect(thread.turns.filter(turn => !turn.judge && turn.user.text.includes('Outline the launch')).map(turn => [turn.interrupted, turn.status])).toEqual([[true, 'done']]);
  } finally { release(); await f.cleanup(); await model.close(); }
});


test('reopening after a write crash preserves history and never resends the uncertain write', async () => {
  const f = fixture();
  try {
    let page = await f.launch({ BACKBONE_HARNESS: 'harness-stub', BACKBONE_CRASH_AT: 'write.begun' });
    const { threadId, projectId } = await createChat(page);
    await setGoal(page, 'Write an editable brief');
    const crashed = f.waitForCrash();
    void page.getByTestId('thread-goal').getByRole('button', { name: 'Run until met', exact: true }).click().catch(() => {});
    await crashed;
    page = await f.launch({ BACKBONE_HARNESS: 'harness-stub' }); await openChat(page);
    await expect(page.getByTestId('effect-UNKNOWN')).toContainText('brief.md');
    await expect.poll(async () => (await read(page, threadId)).goalRun?.status).toBe('interrupted');
    await page.getByTestId('thread-goal').getByRole('button', { name: 'Resume', exact: true }).click();
    await expect.poll(async () => (await read(page, threadId)).goalRun?.status).toBe('blocked');
    const thread = await read(page, threadId);
    expect(thread.turns).toHaveLength(2);
    expect(thread.turns[0].user.text).toBe('Ready to work');
    expect(thread.turns[1].effects.map(effect => effect.outcome)).toEqual(['UNKNOWN']);
    const files = await api<{ name: string }[]>(page, 'material.list', { projectId });
    expect(files.filter(file => file.name === 'brief.md').length).toBeLessThanOrEqual(1);
  } finally { await f.cleanup(); }
});
