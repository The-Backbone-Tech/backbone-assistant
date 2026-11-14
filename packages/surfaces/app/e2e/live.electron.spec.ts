import { TEST_HANG_MS, hangDetector } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// The whole journey on a real model in the app, through the renderer's own transport: a document,
// a person's edit, a revision on top of it, a Stop, a quit and a cold start. It uses the signed-in
// Codex client and spends its quota, so it runs only when asked:
//   BACKBONE_LIVE=1 [BACKBONE_APP_EXECUTABLE=<installed app>] npx playwright test --project=electron e2e/live
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMoreView } from './journey';

const installed = process.env.BACKBONE_APP_EXECUTABLE;
const appDir = join(import.meta.dirname, '..');
const MODEL = process.env.BACKBONE_LIVE_MODEL ?? 'gpt-6.1-terra';
const settings = { permission: 'full', model: MODEL, effort: 2, runsOn: 'this-computer', mode: 'chat' };
let home = '';
let app: ElectronApplication;
let page: Page;

async function launch() {
  home ||= mkdtempSync(join(tmpdir(), 'backbone-live-'));
  const env = { ...process.env, BACKBONE_HOME: home } as Record<string, string>;
  for (const k of ['BACKBONE_MODEL_ENDPOINT', 'BACKBONE_MODEL_ID', 'BACKBONE_HARNESS']) delete env[k];
  app = await electron.launch(installed ? { env, executablePath: installed, args: [] } : { env, args: [appDir] });
  page = await app.firstWindow();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
}
const api = <T>(method: string, args: unknown) => page.evaluate(([m, a]) =>
  (window as unknown as { backbone: { call(m: string, a: unknown): Promise<unknown> } }).backbone.call(m as string, a), [method, args]) as Promise<T>;
const value = async <T>(p: Promise<{ ok: boolean; value: T; detail?: string }>) => { const r = await p; if (!r.ok) throw new Error(r.detail); return r.value; };
type Thread = { summary: { running: boolean }; turns: { status: string; work: { harness: string }; effects: { outcome: string }[]; answer?: { text: string } }[] };
async function settled(id: string) {
  await expect.poll(async () => (await value(api<{ ok: boolean; value: Thread }>('threads.get', { id }))).summary.running, { timeout: TEST_HANG_MS, intervals: [500] }).toBe(false);
  return value(api<{ ok: boolean; value: Thread }>('threads.get', { id }));
}
const quit = () => hangDetector(app.close().catch(() => undefined), 'live Electron app close');

test.setTimeout(600_000);
test.afterAll(async () => { if (!home) return; await quit(); await removeDataHome(home); });

// Only when asked: it spends the signed-in client's quota.
const live = process.env.BACKBONE_LIVE ? test : () => undefined;

live('real model: write, person edits, revise, stop, quit, cold start', async () => {
  await launch();
  expect((await api<{ id: string }[]>('models.list', {})).map((m) => m.id)).toContain(MODEL);
  const p = await value(api<{ ok: boolean; value: { id: string } }>('projects.create', { name: 'Live', kind: 'folder' }));
  const send = (text: string, clientKey: string, threadId?: string) => value(api<{ ok: boolean; value: { threadId: string } }>('turns.send', { threadId, projectId: p.id, text, attachments: [], settings, clientKey }));

  // The first message goes through the composer, as a person sends it, with no settings chosen.
  await page.reload();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
  await page.getByRole('button', { name: 'Live' }).first().click();
  await page.locator('textarea').first().fill('Create plan.md with a title and the line: The launch is on Friday 14.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await api<{ id: string; projectId: string }[]>('threads.list', {})).filter((t) => t.projectId === p.id).length, { timeout: TEST_HANG_MS }).toBe(1);
  const first = { threadId: (await api<{ id: string }[]>('threads.list', {}))[0].id };
  const wrote = await settled(first.threadId);
  expect(wrote.turns[0].work.harness).toMatch(/^Codex/);
  expect(wrote.turns[0].effects.at(-1)?.outcome, JSON.stringify(wrote.turns[0]).slice(0, 1200)).toBe('DONE');
  const list = () => api<{ id: string; name: string; current: number }[]>('material.list', { projectId: p.id });
  const plan = (await list()).find((m) => m.name === 'plan.md')!;

  await value(api('material.save', { id: plan.id, text: '# Plan\n\nThe launch moved to Monday 17.\n', baseVersion: plan.current }));
  const second = await send('Add a final line to plan.md starting "Risks:" naming one risk. Keep everything else.', 'b', first.threadId);
  await settled(second.threadId);
  const revised = (await value(api<{ ok: boolean; value: { text: string } }>('material.read', { id: plan.id }))).text;
  expect(revised).toContain('Monday 17');
  expect(revised).toMatch(/Risks:/);

  const third = await send('Write notes.md with ten short lines about launch risks.', 'c', first.threadId);
  await new Promise((r) => setTimeout(r, 1500));
  await value(api('turns.stop', { threadId: third.threadId }));
  const stopped = (await settled(third.threadId)).turns.at(-1)!;
  expect(stopped.status).toBe('stopped');

  await quit();
  await launch();
  const reopened = await value(api<{ ok: boolean; value: Thread }>('threads.get', { id: first.threadId }));
  expect(reopened.turns.length).toBe(3);
  expect((await value(api<{ ok: boolean; value: { text: string } }>('material.read', { id: plan.id }))).text).toContain('Monday 17');
  const now = await api<{ needsYou: { kind: string }[] }>('work.now', { projectId: p.id });
  expect(now.needsYou.map((n) => n.kind)).toContain('stopped');
  await page.getByText(/Create plan\.md/).first().click();
  await openMoreView(page, 'Now');
  const view = page.getByTestId('work-now');
  await expect(view.getByTestId('now-needs-you').first()).toContainText('stopped before it finished');
  await expect(view).toContainText('plan.md');
  await page.screenshot({ path: join(appDir, '../../../evidence/live-now.png') });
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'AI and models' }).click();
  await expect(dialog.getByLabel('Codex model').locator('option').first()).toBeAttached();
});
