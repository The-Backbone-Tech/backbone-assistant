import { TEST_HANG_MS, hangDetector } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// Talking to running work on a real model in the app, through the renderer's own transport: a message
// queued during a turn, words steered at a turn, and a worker's document brought back, clean and after
// a person's edit. It uses the signed-in Codex client and spends its quota, so it runs only when asked:
//   BACKBONE_LIVE=1 [BACKBONE_APP_EXECUTABLE=<installed app>] npx playwright test --project=electron e2e/live-steer
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const installed = process.env.BACKBONE_APP_EXECUTABLE;
const appDir = join(import.meta.dirname, '..');
const MODEL = process.env.BACKBONE_LIVE_MODEL ?? 'gpt-6.1-terra';
const settings = { permission: 'full', model: MODEL, effort: 2, runsOn: 'this-computer', mode: 'chat' };
let home = '';
let app: ElectronApplication;
let page: Page;

async function launch() {
  home ||= mkdtempSync(join(tmpdir(), 'backbone-live-steer-'));
  const env = { ...process.env, BACKBONE_HOME: home } as Record<string, string>;
  for (const k of ['BACKBONE_MODEL_ENDPOINT', 'BACKBONE_MODEL_ID', 'BACKBONE_HARNESS']) delete env[k];
  app = await electron.launch(installed ? { env, executablePath: installed, args: [] } : { env, args: [appDir] });
  page = await app.firstWindow();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
}
const api = <T>(method: string, args: unknown) => page.evaluate(([m, a]) =>
  (window as unknown as { backbone: { call(m: string, a: unknown): Promise<unknown> } }).backbone.call(m as string, a), [method, args]) as Promise<T>;
type Receipt<T> = { ok: true; value: T } | { ok: false; reason: string; detail: string };
const value = async <T>(p: Promise<Receipt<T>>) => { const r = await p; if (!r.ok) throw new Error(r.detail); return r.value; };
interface Doc { materialId: string; name: string; version: number; current: number; state: string; by: string }
interface Turn { user: { text: string }; status: string; work: { harness: string }; answer?: { text: string }; effects: { target: string; outcome: string }[]; steers?: { text: string; state: string; detail?: string }[]; merge?: { outcome: string; beside?: { name: string }; receipts: { outcome: string }[] } }
interface Thread { summary: { running: boolean; title: string }; queue?: { text: string }[]; queueHeld?: string; steering?: { available: boolean }; turns: Turn[]; children?: { threadId: string; running: boolean; documents?: Doc[] }[] }
const thread = (id: string) => value(api<Receipt<Thread>>('threads.get', { id }));
async function settled(id: string) {
  await expect.poll(async () => (await thread(id)).summary.running, { timeout: TEST_HANG_MS, intervals: [500] }).toBe(false);
  return thread(id);
}
const quit = () => hangDetector(app.close().catch(() => undefined), 'live Electron app close');
/** A real turn long enough to act on while it runs. */
const LONG = 'Write notes.md with sixty numbered lines, each a short distinct remark about launch risks. Then reply with the single word: finished.';

test.setTimeout(900_000);
test.afterAll(async () => { if (!home) return; await quit(); await removeDataHome(home); });

// Only when asked: it spends the signed-in client's quota.
const live = process.env.BACKBONE_LIVE ? test : () => undefined;

live('real model: a queued message goes once, a steer says what Codex confirmed, a document comes back clean and beside', async () => {
  await launch();
  const p = await value(api<Receipt<{ id: string }>>('projects.create', { name: 'Live steer', kind: 'folder' }));
  const send = (text: string, clientKey: string, threadId?: string) => value(api<Receipt<{ threadId: string }>>('turns.send', { threadId, projectId: p.id, text, attachments: [], settings, clientKey }));
  const first = await send('Reply with the single word: ready.', 'first');
  const id = first.threadId;
  const ready = await settled(id);
  expect(ready.turns[0].work.harness).toMatch(/^Codex/);
  expect(ready.steering?.available).toBe(true);

  await page.reload();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
  await page.getByRole('button', { name: 'Live steer' }).first().click();
  await page.getByRole('navigation').getByText('Reply with the single word').first().click();
  const composer = page.getByRole('textbox', { name: 'Message' });

  // Queue during a real turn, as a person does.
  await send(LONG, 'long', id);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: TEST_HANG_MS });
  await composer.fill('Reply with the single word: queued.');
  await page.getByRole('button', { name: 'Send when done' }).click();
  await expect(page.getByTestId('queued-message')).toHaveCount(1);
  await expect.poll(async () => (await thread(id)).turns.filter((t) => t.user.text.includes('word: queued')).length, { timeout: TEST_HANG_MS, intervals: [500] }).toBe(1);
  const queued = await settled(id);
  const long = queued.turns.find((t) => t.user.text === LONG)!;
  expect(long.status, JSON.stringify(long).slice(0, 800)).toBe('done');
  expect(queued.turns.filter((t) => t.user.text.includes('word: queued')).length).toBe(1);
  expect(queued.queue ?? []).toEqual([]);

  // Steer a real turn, and record what came of it.
  await send(LONG.replace('notes.md', 'more-notes.md'), 'steered', id);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: TEST_HANG_MS });
  await page.waitForTimeout(1_500);
  await composer.fill('Also add one last line to the file: steered-word-blue.');
  await page.getByTestId('composer').getByRole('button', { name: 'Steer', exact: true }).click();
  const after = await settled(id);
  const steer = after.turns.at(-1)!.steers?.[0];
  console.log('LIVE steer record:', JSON.stringify({ state: steer?.state, detail: steer?.detail, turn: after.turns.at(-1)!.status, queue: after.queue?.length ?? 0 }));
  const row = page.getByTestId('turn-steer');
  if (steer?.state === 'delivered') {
    await expect(row).toContainText('Reached the turn');
    const made = (await api<{ id: string; name: string }[]>('material.list', { projectId: p.id })).find((m) => m.name === 'more-notes.md');
    console.log('LIVE steered words in the file:', made ? (await value(api<Receipt<{ text: string }>>('material.read', { id: made.id }))).text.includes('steered-word-blue') : 'no file');
  } else {
    await expect(row).not.toContainText('Reached the turn');
  }

  // Bring a real worker's document back, clean.
  const worker = await value(api<Receipt<{ threadId: string }>>('children.start', { parentThreadId: id, text: 'Create risks.md with three short lines about launch risks.', role: 'worker', clientKey: 'worker' }));
  await settled(worker.threadId);
  const docOf = async (child: string, name: string) => (await thread(id)).children!.find((c) => c.threadId === child)!.documents!.find((d) => d.name === name)!;
  const clean = await docOf(worker.threadId, 'risks.md');
  expect(clean.state).toBe('ready');
  const row1 = page.getByTestId('child-document').filter({ hasText: 'risks.md' });
  await row1.getByRole('button', { name: 'Bring back' }).click();
  await expect(row1).toContainText('Brought back', { timeout: TEST_HANG_MS });
  const merged = (await settled(id)).turns.at(-1)!;
  expect(merged.merge?.outcome).toBe('adopted');
  expect(merged.merge?.receipts.at(-1)?.outcome).toBe('DONE');
  expect((await value(api<Receipt<{ entry: { current: number } }>>('material.read', { id: clean.materialId }))).entry.current).toBe(clean.version);

  // And after a person's edit: their version stands, and the worker's lands beside it.
  const second = await value(api<Receipt<{ threadId: string }>>('children.start', { parentThreadId: id, text: 'Create rollout.md with three short lines about rollout.', role: 'worker', clientKey: 'second' }));
  await settled(second.threadId);
  const fresh = await docOf(second.threadId, 'rollout.md');
  const workerText = (await value(api<Receipt<{ text: string }>>('material.read', { id: fresh.materialId, version: fresh.version }))).text;
  await value(api('material.save', { id: fresh.materialId, text: 'The person\'s own rollout.\n', baseVersion: fresh.current }));
  const row2 = page.getByTestId('child-document').filter({ hasText: 'rollout.md' });
  await row2.getByRole('button', { name: 'Keep beside yours' }).click();
  await expect(row2).toContainText('Brought back', { timeout: TEST_HANG_MS });
  const beside = (await settled(id)).turns.at(-1)!;
  expect(beside.merge?.outcome, JSON.stringify(beside).slice(0, 800)).toBe('beside');
  expect(beside.effects.at(-1)?.outcome).toBe('DONE');
  expect((await value(api<Receipt<{ text: string }>>('material.read', { id: fresh.materialId }))).text).toBe('The person\'s own rollout.\n');
  const copy = (await api<{ id: string; name: string }[]>('material.list', { projectId: p.id })).find((m) => m.name === beside.merge!.beside!.name)!;
  expect((await value(api<Receipt<{ text: string }>>('material.read', { id: copy.id }))).text).toBe(workerText);
});
