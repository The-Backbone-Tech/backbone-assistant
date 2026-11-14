// First run: a new data folder is told once what Full access reaches, and can pick something narrower.
// Real app renderer over a controlled API transport whose viewer prefs and chats survive a reload,
// as they do on disk (owner direction 13 Nov 2026, first real use).
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFS } from '@backbone-next/platform';

let server: ViteDevServer; let url: string;
test.beforeAll(async () => { server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } }); await server.listen(); url = server.resolvedUrls!.local[0]; });
test.afterAll(async () => { await server?.close(); });

async function open(page: import('@playwright/test').Page, options: { chat?: boolean; codex?: boolean; shared?: boolean; nonDevice?: boolean } = {}) {
  await page.addInitScript(({ prefs, options }) => {
    const at = '2026-11-13T10:00:00Z';
    // The "disk": written once, so a reload sees what the last session saved.
    const disk = JSON.parse(localStorage.getItem('disk') ?? 'null') ?? { prefs: { ...prefs, selectedProjectId: 'proj' }, projects: [{ id: 'proj', name: 'Personal', kind: 'folder', createdAt: at }], threads: options.chat ? [{ id: 'thr', projectId: 'proj', title: 'Earlier chat', running: false, updatedAt: at }] : [] };
    const save = () => localStorage.setItem('disk', JSON.stringify(disk));
    save();
    const listeners = new Set<(e: { topic: string; id: string }) => void>();
    Object.assign(window, { disk, backbone: {
      platform: 'linux', setTheme() {}, onEvent(l: (e: { topic: string; id: string }) => void) { listeners.add(l); return () => listeners.delete(l); },
      async call(method: string, args: any) {
        switch (method) {
          case 'host.status': return { owns: true };
          case 'identity.get': return { ok: true, value: { person: { id: 'device', role: 'owner', name: 'Device', status: 'active' }, deviceOwner: !options.nonDevice, people: [] } };
          case 'identity.sharing': return { ok: true, value: { access: 'owner', people: [], grants: [], nativeAccountTools: !options.shared } };
          case 'viewer.get': return disk.prefs;
          case 'viewer.put': disk.prefs = args.prefs; save(); return args.prefs;
          case 'models.list': return [{ id: 'stub', label: 'Controlled model', efforts: [3] }];
          case 'settings.model.get': return options.codex ? { native: { provider: 'codex', model: 'gpt' }, harness: 'codex' } : { harness: 'stub' };
          case 'projects.list': return structuredClone(disk.projects);
          case 'threads.list': return structuredClone(disk.threads);
          case 'turns.send':
            disk.threads.push({ id: 'thr', projectId: args.projectId, title: 'First chat', running: true, updatedAt: at }); save();
            setTimeout(() => listeners.forEach((l) => l({ topic: 'thread', id: 'thr' })), 0);
            return { ok: true, value: { threadId: 'thr' } };
          case 'threads.get': return { ok: true, value: { summary: disk.threads[0], turns: [{ id: 'turn', status: 'running', user: { text: 'Hello there', attachments: [], at }, work: { startedAt: at, steps: [], harness: 'controlled' }, effects: [] }], sideTurns: [], card: { project: 'Personal', sources: [], changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 } } } };
          case 'drafts.get': return disk.drafts?.[args.key] ?? null;
          case 'drafts.put': { disk.drafts ??= {}; const prior = disk.drafts[args.key]; disk.drafts[args.key] = { ...args, revision: (prior?.revision ?? 0) + 1, updatedAt: at }; return { ok: true, value: disk.drafts[args.key] }; }
          case 'plugins.parts': case 'material.list': case 'files.list': return [];
          default: return null;
        }
      },
    } });
  }, { prefs: DEFAULT_PREFS, options });
  await page.goto(url);
}

const card = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Full access' });

test('a fresh data folder shows the card once, with the Codex connectors only on the Codex engine', async ({ page }) => {
  await open(page, { codex: true });
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText('starts with Full access');
  await expect(card(page)).toContainText('connectors of your own Codex app');
  await expect(card(page)).toContainText('without asking each time');
  await expect(page.getByRole('button', { name: 'Permissions: Full access' })).toBeVisible();
});

test('on another engine the card does not mention the Codex connectors', async ({ page }) => {
  await open(page);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).not.toContainText('Codex');
});

test('Keep Full access records the decision for this data folder across a reload', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Keep Full access' }).click();
  await expect(card(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('Choose another opens the permission menu and the card is gone', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Choose another' }).click();
  await expect(page.getByRole('menuitemradio', { name: /Auto-review/ })).toBeVisible();
  await page.getByRole('menuitemradio', { name: /Ask for approval/ }).click();
  await expect(page.getByRole('button', { name: 'Permissions: Ask for approval' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await page.reload();
  await expect(card(page)).toHaveCount(0);
});

test('sending a first message records the decision', async ({ page }) => {
  await open(page);
  await expect(card(page)).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('Hello there');
  await box.press('Enter');
  await expect(page.getByRole('list', { name: 'Transcript' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).disk.prefs.fullAccessNotice)).toBe('decided');
  await page.evaluate(() => { (window as any).disk.threads.length = 0; localStorage.setItem('disk', JSON.stringify((window as any).disk)); });
  await page.reload();
  await expect(card(page)).toHaveCount(0);
});

test('a data folder that already has a chat never shows the card', async ({ page }) => {
  await open(page, { chat: true });
  await expect(page.getByRole('button', { name: 'Permissions: Full access' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});


test('a shared project omits the personal Codex connectors from its first-run card', async ({ page }) => {
  await open(page, { codex: true, shared: true });
  await expect(card(page)).toBeVisible();
  await expect(card(page)).not.toContainText('connectors of your own Codex app');
});

test('a signed-in non-device owner never receives the Full access card', async ({ page }) => {
  await open(page, { codex: true, nonDevice: true });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});
