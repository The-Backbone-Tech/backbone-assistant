import { expect, test as base, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

export const side = (page: Page) => page.getByRole('textbox', { name: 'Ask the side chat', exact: true });

// Worker fixtures own their server and cache. Build metadata changes must not reload a synthetic
// transport: doing so discards its held calls and resets the scenario halfway through an assertion.
export const test = base.extend<{ sidechatReady: void }, { sidechatUrl: string }>({
  sidechatUrl: [async ({}, use) => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'sidechat-vite-'));
    let server: ViteDevServer | undefined;
    try {
      server = await createServer({
        root: fileURLToPath(new URL('..', import.meta.url)), cacheDir,
        server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
      });
      await server.listen();
      await use(server.resolvedUrls!.local[0]);
    } finally {
      try { await server?.close(); } finally { await rm(cacheDir, { recursive: true, force: true }); }
    }
  }, { scope: 'worker' }],
  sidechatReady: [async ({ page, sidechatUrl }, use) => {
    await page.addInitScript(() => {
      const at = new Date().toISOString();
      const summaries = ['a', 'b'].map(id => ({ id, projectId: 'p', title: `Thread ${id.toUpperCase()}`, running: false, createdAt: at, updatedAt: at }));
      const prefs = { theme: 'light', selectedProjectId: 'p', selectedThreadId: 'a', pane: { open: true, tabs: [{ id: 'side-chat', kind: 'side-chat' }], active: 'side-chat' } };
      const saved = JSON.parse(sessionStorage.getItem('sidechat-fixture') ?? '{"drafts":{}}');
      type Event = { method: string; args: any; held: boolean; returned: boolean; release?: () => void };
      const f = {
        drafts: saved.drafts, sideTurns: saved.sideTurns ?? [], calls: [] as any[], events: [] as Event[],
        hold: false, holdStop: false, stopRefused: false, mode: 'ok', failSave: false, holdDraft: saved.holdDraft ?? false,
      };
      const save = () => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ drafts: f.drafts, sideTurns: f.sideTurns }));
      Object.assign(window, { fixture: f, backbone: {
        platform: 'linux', setTheme() {}, onEvent() { return () => {}; },
        async call(method: string, args: any) {
          const event: Event = { method, args: structuredClone(args), held: false, returned: false };
          f.events.push(event);
          const hold = () => new Promise<void>(release => { event.held = true; event.release = release; });
          try {
            switch (method) {
              case 'identity.get': return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
         case 'host.status': return { owns: true };
              case 'viewer.get': return prefs;
              case 'viewer.put': return args.prefs;
              case 'projects.list': return [{ id: 'p', name: 'Side-chat fixture', kind: 'folder', createdAt: at }];
              case 'threads.list': return summaries;
              case 'threads.get': return { ok: true, value: { summary: summaries.find(t => t.id === args.id), turns: [], sideTurns: args.id === 'a' ? f.sideTurns : [], card: { project: 'Side-chat fixture', sources: [], changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 } } } };
              case 'models.list': return [{ id: 'stub', label: 'Controlled', efforts: [3] }];
              case 'plugins.parts': case 'files.list': case 'material.list': return [];
              case 'drafts.get':
                if (f.holdDraft && args.key === 'side-chat:a') {
                  const captured = structuredClone(f.drafts[args.key] ?? null);
                  await hold();
                  return captured;
                }
                return f.drafts[args.key] ?? null;
              case 'drafts.put':
                if (f.failSave) throw new Error('Controlled save failure');
                f.drafts[args.key] = { ...args, updatedAt: at }; save();
                return { ok: true, value: f.drafts[args.key] };
              case 'sidechat.ask':
                f.calls.push(structuredClone(args));
                if (f.hold) await hold();
                if (f.mode === 'lost') throw new Error('Controlled response loss');
                if (f.mode === 'pending') return { ok: true, value: { status: 'stopped', sideRecoveryPending: true } };
                return f.mode === 'refused' ? { ok: false, reason: 'NOT_FOUND', outcome: 'REFUSED', detail: 'Thread no longer exists.' } : { ok: true, value: {} };
              case 'sidechat.stop':
                f.calls.push({ method, ...args });
                if (f.holdStop) await hold();
                return f.stopRefused ? { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'Stop was refused.' } : { ok: true, value: { stopped: true } };
              default: return null;
            }
          } finally { event.returned = true; }
        },
      } });
    });
    await page.goto(sidechatUrl);
    await expect(side(page)).toBeEnabled();
    await use();
  }, { auto: true }],
});

async function callCount(page: Page, method: string, args: Record<string, string>, phase: 'held' | 'returned') {
  return page.evaluate(({ method, args, phase }) => (window as any).fixture.events.filter((event: any) =>
    event.method === method && event[phase] && Object.entries(args).every(([key, value]) => event.args[key] === value),
  ).length, { method, args, phase });
}

export async function waitForFixture(page: Page, method: string, args: Record<string, string> = {}, phase: 'held' | 'returned' = 'returned') {
  await expect.poll(() => callCount(page, method, args, phase)).toBeGreaterThan(0);
}

export async function select(page: Page, letter: string) {
  const args = { id: letter.toLowerCase() };
  const before = await callCount(page, 'threads.get', args, 'returned');
  const button = page.getByRole('navigation').getByRole('button', { name: `Thread ${letter}`, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => callCount(page, 'threads.get', args, 'returned')).toBeGreaterThan(before);
  await expect(side(page)).toBeEnabled();
}

export async function releaseFixture(page: Page, method: 'drafts.get' | 'sidechat.ask' | 'sidechat.stop') {
  const ids = await page.evaluate(method => {
    const f = (window as any).fixture;
    const ids: number[] = f.events.flatMap((event: any, id: number) => event.method === method && event.held && !event.returned ? [id] : []);
    if (!ids.length) throw new Error(`No held fixture call to release: ${method}`);
    if (method === 'drafts.get') f.holdDraft = false;
    if (method === 'sidechat.ask') f.hold = false;
    if (method === 'sidechat.stop') f.holdStop = false;
    // StrictMode can start more than one read. Release and join every captured call, not just the
    // most recently assigned resolver, so the late-read assertion actually observes their return.
    for (const id of ids) f.events[id].release();
    return ids;
  }, method);
  await expect.poll(() => page.evaluate(ids => ids.every(id => (window as any).fixture.events[id].returned), ids)).toBe(true);
}
