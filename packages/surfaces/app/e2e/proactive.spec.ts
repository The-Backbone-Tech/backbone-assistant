// The daily brief and an emergency as a person meets them: the brief waits in Needs you, each item
// one click; an emergency is told at once with a banner. Synthetic transport: no model or database.
import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFS } from '@backbone-next/platform';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function open(page: Page, { held = false } = {}) {
  await page.addInitScript(({ prefs, held }) => {
    const at = '2026-11-02T09:00:00Z';
    const summary = (id: string, title: string) => ({ id, projectId: 'p', title, pinned: false, unread: false, archived: false, running: false, updatedAt: at });
    const threads = [summary('beat', 'Heartbeat check: invoices'), summary('t', 'Launch notes')];
    const thread = (id: string) => ({ summary: threads.find((t) => t.id === id), turns: [], sideTurns: [], card: { project: 'Ops', sources: [], changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 } } });
    const brief = { date: '2026-11-02', at, items: [
      { id: 'i1', runId: 'r1', threadId: 'beat', title: 'The ACME invoice is overdue and needs your decision.', detail: 'Heartbeat · 09:20', done: false },
      { id: 'i2', runId: null, threadId: null, title: '2 scheduled runs finished', detail: 'See Scheduled.', done: false },
    ] };
    const listeners = new Set<(e: { topic: string; id?: string; urgent?: string }) => void>();
    const fixture = { calls: [] as { method: string; args: unknown }[], emit: (e: { topic: string; urgent?: string }) => listeners.forEach((f) => f(e)) };
    Object.assign(window, { fixture });
    Object.assign(window, { backbone: {
      platform: 'linux', setTheme() {},
      onEvent(listener: (e: { topic: string }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async call(method: string, args: { id?: string }) {
        fixture.calls.push({ method, args });
        switch (method) {
          case 'identity.get': return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
          case 'viewer.get': return { ...prefs, selectedProjectId: 'p' };
          case 'viewer.put': return prefs;
          case 'models.list': return [{ id: 'stub', label: 'Controlled model', efforts: [3] }];
          case 'projects.list': return [{ id: 'p', name: 'Ops', kind: 'folder', createdAt: at }];
          case 'threads.list': return threads;
          case 'threads.get': return { ok: true, value: thread(args.id!) };
          case 'schedules.get': return { schedules: [], heartbeat: null, runs: [], brief: { time: '09:25', latest: brief }, interruptions: { date: '2026-11-02', briefs: 1, emergencies: [] } };
          case 'brief.done': { const item = brief.items.find((i) => i.id === args.id)!; item.done = true; return { ok: true, value: brief }; }
          case 'connectors.list': return { servers: [], egress: 'per-server', held: held ? [
            { effect: 'e1', serverId: 'home:gmail', serverName: 'gmail', tool: 'draft_gmail_message', args: {}, argsHash: 'h1', statement: 'Save a draft to you: Backbone connection check', at, state: 'waiting', detail: '' },
            { effect: 'e0', serverId: 'home:gmail', serverName: 'gmail', tool: 'draft_gmail_message', args: {}, argsHash: 'h0', statement: 'An earlier draft', at, state: 'discarded', detail: '' },
          ] : [] };
          case 'drafts.get': return null;
          case 'material.list': case 'files.list': return [];
          default: return null;
        }
      },
    } });
  }, { prefs: DEFAULT_PREFS, held });
  await page.goto(url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
}

test('the daily brief waits in Needs you, and each item is one click', async ({ page }) => {
  await open(page);
  const needs = page.getByRole('button', { name: /^Needs you/ });
  await expect(needs).toHaveAccessibleName('Needs you (2)');
  await expect(needs).toHaveText('');
  await needs.click();
  const panel = page.getByTestId('needs-you');
  await expect(panel).toContainText('Daily brief');
  await expect(panel.getByTestId('brief-item')).toHaveCount(2);
  await panel.getByTestId('brief-item').first().click();
  await expect(page.getByTestId('turn')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Chat details' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.some((c: any) => c.method === 'brief.done' && c.args.id === 'i1'))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.some((c: any) => c.method === 'viewer.put' && c.args.prefs.selectedThreadId === 'beat'))).toBe(true);
});

test('an emergency is told at once, and can be opened or set aside', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).fixture.emit({ topic: 'schedules', urgent: 'An API key was pasted into a shared note.' }));
  const banner = page.getByRole('alert').filter({ hasText: 'Emergency' });
  await expect(banner).toContainText('An API key was pasted into a shared note.');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
});

test('a change a connected tool asked for waits in Needs you, and opens Connected tools', async ({ page }) => {
  await open(page, { held: true });
  const needs = page.getByRole('button', { name: /^Needs you/ });
  // The two brief items and the one waiting call; a call already decided does not count.
  await expect(needs).toHaveAccessibleName('Needs you (3)');
  await needs.click();
  const panel = page.getByTestId('needs-you');
  await expect(panel).toContainText('Held for you');
  await expect(panel.getByTestId('held-waiting')).toHaveCount(1);
  await expect(panel.getByTestId('held-waiting')).toContainText('Save a draft to you: Backbone connection check');
  await panel.getByTestId('held-waiting').click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('heading', { name: 'Connected tools' })).toBeVisible();
  // Releasing stays in Connected tools, in the app's own process: Needs you only points there.
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.some((c: any) => c.method === 'connectors.decide'))).toBe(false);
});

test('script-check settings request native confirmation and never send a direct gate mutation', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const win = window as any;
    const original = win.backbone.call;
    win.fixture.native = [];
    win.backbone.configureWakeGate = async (request: unknown) => { win.fixture.native.push(request); return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'Native confirmation declined.' }; };
    win.backbone.call = async (method: string, args: unknown) => {
      const result = await original(method, args);
      if (method !== 'schedules.get') return result;
      return { ...result, schedules: [{ id: 'script-s', kind: 'schedule', projectId: 'p', threadId: null, text: 'Inspect local changes', when: 'every hour', summary: 'Every hour', version: 1, settings: { permission: 'full', runsOn: 'this-computer', mode: 'chat', model: 'stub', effort: 3 } }] };
    };
    win.fixture.emit({ topic: 'schedules' });
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Heartbeat and brief', exact: true }).click();
  await dialog.getByLabel('Script check schedule').selectOption('script-s');
  await dialog.getByLabel('Wake-gate program').fill('/usr/bin/program');
  await dialog.getByLabel('Wake-gate arguments').fill('["an exact argument"]');
  await dialog.getByRole('button', { name: 'Review script check', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.native.length)).toBe(1);
  const captured = await page.evaluate(() => ({ native: (window as any).fixture.native, raw: (window as any).fixture.calls.filter((c: any) => ['schedules.create', 'schedules.update'].includes(c.method)) }));
  expect(captured.raw).toEqual([]);
  expect(captured.native[0]).toEqual({ method: 'schedules.update', args: { id: 'script-s', baseVersion: 1, patch: { wakeGate: { command: '/usr/bin/program', args: ['an exact argument'], timeoutMs: 5000 } } } });
});

test('turning off a loaded heartbeat submits disable even while its live view is still loading', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const win = window as any, original = win.backbone.call;
    let reads = 0;
    win.backbone.call = async (method: string, args: unknown) => {
      if (method === 'heartbeat.put') { win.fixture.calls.push({ method, args }); return { ok: true, value: null }; }
      if (method !== 'schedules.get') return original(method, args);
      // The section's live hook and its form initialization are separate requests. Deliver the
      // initialization first, leaving the live view at its empty fallback until after the click.
      if (++reads === 1) return new Promise(() => {});
      const result = await original(method, args);
      return { ...result, heartbeat: { id: 'beat', projectId: 'p', text: 'Check invoices', rule: { kind: 'rrule', rrule: 'FREQ=HOURLY;INTERVAL=2' }, hours: { start: '08:00', end: '20:00' } } };
    };
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Heartbeat and brief', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Heartbeat' })).toBeChecked();
  await expect(dialog.getByRole('spinbutton', { name: 'Every (minutes)' })).toHaveValue('120');
  await dialog.getByRole('checkbox', { name: 'Heartbeat' }).uncheck();
  const calls = await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.method === 'heartbeat.put'));
  expect(calls).toHaveLength(1); expect(calls[0].args.enabled).toBe(false);
});
