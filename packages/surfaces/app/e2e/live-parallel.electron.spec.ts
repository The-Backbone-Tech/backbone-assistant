import { TEST_HANG_MS, hangDetector } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// Goals and workers on a real model in the app, through the renderer's own transport: a goal, a
// worker that writes a document and hands it back, a Stop on the parent that reaches a running
// worker, and a quit and cold start. It uses the signed-in Codex client and spends its quota, so it
// runs only when asked:
//   BACKBONE_LIVE=1 [BACKBONE_APP_EXECUTABLE=<installed app>] npx playwright test --project=electron e2e/live-parallel
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
  home ||= mkdtempSync(join(tmpdir(), 'backbone-live-parallel-'));
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
interface Handover { status: string; text: string; files: { name: string }[]; receipts: { outcome: string }[] }
interface Thread {
  summary: { running: boolean };
  goal?: { current: { text: string } | null; version: number };
  children?: { threadId: string; role: string; running: boolean; handover?: Handover }[];
  turns: { status: string; work: { harness: string }; handovers?: unknown[] }[];
}
const thread = (id: string) => value(api<Receipt<Thread>>('threads.get', { id }));
async function settled(id: string) {
  await expect.poll(async () => (await thread(id)).summary.running, { timeout: TEST_HANG_MS, intervals: [500] }).toBe(false);
  return thread(id);
}
const quit = () => hangDetector(app.close().catch(() => undefined), 'live Electron app close');

test.setTimeout(600_000);
test.afterAll(async () => { if (!home) return; await quit(); await removeDataHome(home); });

// Only when asked: it spends the signed-in client's quota.
const live = process.env.BACKBONE_LIVE ? test : () => undefined;

live('real model: goal, worker hands back a document, parent Stop reaches a worker, cold start', async () => {
  await launch();
  const p = await value(api<Receipt<{ id: string }>>('projects.create', { name: 'Live parallel', kind: 'folder' }));
  const sent = await value(api<Receipt<{ threadId: string }>>('turns.send', { projectId: p.id, text: 'Reply with the single word: ready.', attachments: [], settings, clientKey: 'first' }));
  const parent = sent.threadId;
  expect((await settled(parent)).turns[0].work.harness).toMatch(/^Codex/);

  const goal = await value(api<Receipt<{ version: number }>>('goals.set', { threadId: parent, text: 'Ship the launch plan', baseVersion: 0 }));
  expect(goal.version).toBeGreaterThan(0);

  const worker = await value(api<Receipt<{ threadId: string }>>('children.start', { parentThreadId: parent, text: 'Create risks.md with three short lines about launch risks.', role: 'worker', clientKey: 'worker' }));
  await settled(worker.threadId);
  const row = (await thread(parent)).children!.find((c) => c.threadId === worker.threadId)!;
  expect(row.handover, JSON.stringify(row).slice(0, 1200)).toBeTruthy();
  expect(row.handover!.status).toBe('done');
  expect(row.handover!.files.map((f) => f.name)).toContain('risks.md');
  expect(row.handover!.receipts.at(-1)?.outcome).toBe('DONE');

  // The default engine cannot hold a reviewer to read-only, and it says so instead of pretending.
  const review = await api<Receipt<unknown>>('children.start', { parentThreadId: parent, text: 'Check risks.md', role: 'reviewer', reviews: parent, clientKey: 'review' });
  expect(review.ok).toBe(false);
  if (!review.ok) expect(review.reason).toBe('NOT_AVAILABLE');

  const running = await value(api<Receipt<{ threadId: string }>>('children.start', { parentThreadId: parent, text: 'Write notes.md with forty lines about launch risks.', role: 'worker', clientKey: 'running' }));
  await new Promise((r) => setTimeout(r, 1500));
  await value(api('turns.stop', { threadId: parent }));
  expect((await settled(running.threadId)).turns.at(-1)!.status).toBe('stopped');

  await quit();
  await launch();
  const reopened = await thread(parent);
  expect(reopened.goal?.current?.text).toBe('Ship the launch plan');
  expect(reopened.children!.map((c) => c.threadId)).toEqual(expect.arrayContaining([worker.threadId, running.threadId]));
  expect(reopened.children!.find((c) => c.threadId === worker.threadId)!.handover!.files.map((f) => f.name)).toContain('risks.md');
});
