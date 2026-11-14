// Real app renderer over a controlled API transport: with no project yet, the first Send makes the
// default project and sends at once, with no dialog (owner direction 13 Nov 2026, first real use).
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFS } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startBridge, stopBridge } from './bridge';
import { api } from './journey';

let server: ViteDevServer; let url: string;
test.beforeAll(async () => { server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } }); await server.listen(); url = server.resolvedUrls!.local[0]; });
test.afterAll(async () => { await server?.close(); });

async function open(page: import('@playwright/test').Page, mode: 'ok' | 'refuse') {
  await page.addInitScript(({ prefs, mode }) => {
    const at = '2026-11-13T10:00:00Z';
    const f = { calls: [] as { method: string; args: any }[], projects: [] as any[], threads: [] as any[], drafts: {} as Record<string, any> };
    const listeners = new Set<(e: { topic: string; id: string }) => void>();
    const emit = () => setTimeout(() => listeners.forEach((l) => l({ topic: 'thread', id: 'thr' })), 0);
    Object.assign(window, { fixture: f, backbone: {
      platform: 'linux', setTheme() {}, onEvent(l: (e: { topic: string; id: string }) => void) { listeners.add(l); return () => listeners.delete(l); },
      async call(method: string, args: any) {
        switch (method) {
          case 'host.status': return { owns: true };
          // Team: the window resolves whose layout it shows before reading any other state.
          case 'identity.get': return { ok: true, value: { person: { id: 'device', name: 'Device', role: 'owner', status: 'active' }, people: [], deviceOwner: true } };
          case 'viewer.get': return prefs;
          case 'viewer.put': return args.prefs;
          case 'models.list': return [{ id: 'stub', label: 'Controlled model', efforts: [3] }];
          case 'projects.list': return structuredClone(f.projects);
          case 'threads.list': return structuredClone(f.threads);
          case 'projects.create':
            f.calls.push({ method, args });
            if (mode === 'refuse') return { ok: false, outcome: 'REFUSED', reason: 'PROJECT_CREATE_FAILED', detail: 'The folder could not be created.' };
            f.projects.push({ id: 'proj', name: args.name, kind: args.kind, createdAt: at });
            emit();
            return { ok: true, value: { id: 'proj' } };
          case 'turns.send':
            f.calls.push({ method, args });
            f.threads.push({ id: 'thr', projectId: args.projectId, title: 'First chat', running: true, updatedAt: at });
            emit();
            return { ok: true, value: { threadId: 'thr' } };
          case 'threads.get': return { ok: true, value: { summary: f.threads[0], turns: [{ id: 'turn', status: 'running', user: { text: 'Hello there', attachments: [], at }, work: { startedAt: at, steps: [], harness: 'controlled' }, effects: [] }], sideTurns: [], card: { project: 'Personal', sources: [], changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 } } } };
          case 'drafts.get': return f.drafts[args.key] ?? null;
          case 'drafts.put': { const prior = f.drafts[args.key]; f.drafts[args.key] = { ...args, revision: (prior?.revision ?? 0) + 1, updatedAt: at }; return { ok: true, value: f.drafts[args.key] }; }
          case 'plugins.parts': case 'material.list': case 'files.list': return [];
          default: return null;
        }
      },
    } });
  }, { prefs: DEFAULT_PREFS, mode });
  await page.goto(url);
}

test('the first Send creates "Personal" and sends the message with no dialog', async ({ page }) => {
  await open(page, 'ok');
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('Hello there');
  await box.press('Enter');
  await expect(page.getByRole('list', { name: 'Transcript' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).fixture.calls);
  expect(calls.map((c: any) => c.method)).toEqual(['projects.create', 'turns.send']);
  expect(calls[0].args).toMatchObject({ name: 'Personal', kind: 'folder' });
  expect(calls[1].args).toMatchObject({ projectId: 'proj', text: 'Hello there' });
});

test('when the default project cannot be created the error shows and the draft stays', async ({ page }) => {
  await open(page, 'refuse');
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('Hello there');
  await box.press('Enter');
  await expect(page.getByText('The folder could not be created.')).toBeVisible();
  await expect(box).toHaveValue('Hello there');
  const calls = await page.evaluate(() => (window as any).fixture.calls);
  expect(calls.map((c: any) => c.method)).toEqual(['projects.create']);
});

// The same first use through the real HTTP bridge, Host and Core on a fresh data folder: Team
// resolves the device owner before the window reads anything, so this proves that resolution
// does not stand between a new person and their first message.
test('on a fresh data folder the first Send through the real bridge creates "Personal" and runs the chat', async ({ page }) => {
  const home = freshDataHome('first-send-bridge');
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge(home, { BACKBONE_HARNESS: 'harness-stub', BACKBONE_USER_HOME: home, BACKBONE_MODEL_ENDPOINT: undefined });
    await page.goto(bridge.url);
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.fill('Hello there');
    await box.press('Enter');
    await expect(page.getByRole('list', { name: 'Transcript' })).toContainText('Hello there');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const projects = await api<{ name: string }[]>(page, 'projects.list', {});
    expect(projects.map((p) => p.name)).toEqual(['Personal']);
  } finally {
    if (bridge) await stopBridge(bridge.proc);
    await removeDataHome(home);
  }
});
