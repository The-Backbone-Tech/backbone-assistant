// Real renderer and existing API shape, synthetic transport: no model, database or external effects.
import { expect, test } from '@playwright/test';
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

test('recorded evidence invalidates during refresh, keeps exact versions, and never hides UNKNOWN', async ({ page }) => {
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ prefs }) => {
    const at = '2026-11-02T09:00:00Z';
    const version = { n: 1, by: 'agent', at, bytes: 2, sha256: 'fixture' };
    const source = { id: 'source', projectId: 'p', name: 'note.md', mediaType: 'text/markdown', class: 'working', hidden: false, current: 1, versions: [version] };
    const output = { ...source, id: 'result', name: 'brief.md' };
    const summary = { id: 't', projectId: 'p', title: 'Prepare a brief', pinned: false, unread: false, archived: false, running: false, updatedAt: at };
    const turn = { id: 'turn', side: false, status: 'done', user: { text: 'Prepare a brief from note.md', attachments: [], at }, reads: [{ id: 'source', name: 'note.md', version: 1, withdrawals: 0 }], work: { startedAt: at, endedAt: at, steps: [{ kind: 'read', label: 'Read note.md v1' }], harness: 'controlled' }, answer: { text: 'Draft ready; one write needs reconciliation.', files: [{ materialId: 'result', name: 'brief.md', version: 1 }] }, effects: [{ key: 'unknown', kind: 'write-working-copy', target: 'uncertain.md', outcome: 'UNKNOWN', detail: 'No confirmed receipt.' }] };
    const thread = { summary, turns: [turn], sideTurns: [], card: { project: 'Evidence fixture', sources: [], changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 } } };
    const listeners = new Set<(event: { topic: string; id: string }) => void>();
    const fixture = { entries: [source, output], fail: false, wait: false, pending: [] as (() => void)[], reads: [] as unknown[], emit: () => listeners.forEach((f) => f({ topic: 'material', id: 'p' })) };
    Object.assign(window, { fixture });
    Object.assign(window, { backbone: {
      platform: 'linux', setTheme() {},
      onEvent(listener: (event: { topic: string; id: string }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async call(method: string, args: { id?: string; version?: number }) {
        switch (method) {
          case 'identity.get': return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
          case 'viewer.get': return { ...prefs, selectedProjectId: 'p', selectedThreadId: 't' };
          case 'viewer.put': return prefs;
          case 'models.list': return [{ id: 'stub', label: 'Controlled model', efforts: [3] }];
          case 'projects.list': return [{ id: 'p', name: 'Evidence fixture', kind: 'folder', createdAt: at }];
          case 'threads.list': return [summary];
          case 'threads.get': return { ok: true, value: thread };
          case 'drafts.get': return null;
          case 'material.list':
            if (fixture.wait) await new Promise<void>((resolve) => { fixture.pending.push(resolve); });
            if (fixture.fail) throw new Error('Controlled metadata failure');
            return structuredClone(fixture.entries);
          case 'material.read': fixture.reads.push(args); return { ok: true, value: { entry: fixture.entries.find((e) => e.id === args.id), text: '# Recorded v1' } };
          case 'files.list': return [];
          default: throw new Error(`Unexpected fixture method ${method}`);
        }
      },
    } });
  }, { prefs: DEFAULT_PREFS });
  await page.goto(url);
  await page.getByTestId('work-block').click();
  const evidence = page.getByTestId('work-evidence');
  await expect(evidence).toContainText('Recorded version is still current.');
  await expect(evidence).not.toContainText('independently verify');
  // Hold the replacement read: a cached "current" label must disappear before it completes.
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.entries[0].current = 2; f.entries[0].versions.push({ ...f.entries[0].versions[0], n: 2, by: 'person' });
    f.wait = true; f.emit();
  });
  await expect(evidence).toContainText('Checking current document versions');
  await expect(evidence).not.toContainText('Recorded version is still current.');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.pending.length)).toBeGreaterThan(0);
  await page.evaluate(() => { const f = (window as any).fixture; f.wait = false; f.pending.splice(0).forEach((resolve: () => void) => resolve()); });
  await expect(evidence).toContainText('Recorded v1; current is v2.');
  await page.screenshot({ path: '../../../evidence/work-evidence/changed-source.png' });
  await page.evaluate(() => { const f = (window as any).fixture; f.fail = true; f.emit(); });
  await expect(evidence.getByRole('alert')).toContainText('could not be checked');
  await expect(evidence).not.toContainText('Recorded version is still current.');
  await page.screenshot({ path: '../../../evidence/work-evidence/unavailable-source.png' });
  await page.evaluate(() => { const f = (window as any).fixture; f.fail = false; f.emit(); });
  await expect(evidence).toContainText('Recorded v1; current is v2.');
  await evidence.getByRole('button', { name: 'note.md v1' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.reads.some((a: any) => a.id === 'source' && a.version === 1))).toBe(true);
  await page.evaluate(() => { const f = (window as any).fixture; f.entries[0].withdrawals = [{ at: '2026-11-02', version: 2 }]; f.emit(); });
  await expect(evidence).toContainText('Withdrawn from later work.');
  await expect(evidence.getByRole('button', { name: 'note.md v1' })).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).fixture; f.entries[0].withdrawals[0].restoredAt = '2026-11-03'; f.emit(); });
  await expect(evidence).toContainText('Access changed since this turn, even if restored.');
  await page.keyboard.press('Control+p');
  await page.getByRole('tablist', { name: 'Pane tabs' }).getByRole('tab', { name: 'Files', exact: true }).click();
  await page.evaluate(() => { const f = (window as any).fixture; f.fail = true; f.emit(); });
  await expect(page.getByText('Document details could not be checked; version information is unavailable.')).toBeVisible();
  await expect(evidence.getByRole('alert')).toContainText('could not be checked');
  await page.evaluate(() => { (window as any).fixture.fail = false; });
  await page.getByRole('button', { name: 'Retry document details' }).click();
  await expect(page.getByRole('button', { name: 'Retry document details' })).toHaveCount(0);
  await page.getByTestId('work-block').click();
  await expect(evidence).toHaveCount(0);
  await expect(page.getByTestId('effect-UNKNOWN')).toBeVisible();
  expect(errors).toEqual([]);
});


test('Now identifies recent generated text as an assistant response', async ({ page }) => {
  await page.addInitScript(({ prefs }) => {
    const at = '2026-11-06T00:00:00Z';
    Object.assign(window, { backbone: { platform: 'linux', setTheme() {}, onEvent() { return () => {}; },
      async call(method: string, args: any) {
        if (method === 'host.status') return { owns: true };
        if (method === 'identity.get') return { ok: true, value: { person: { id: 'fixture-person', name: 'Fixture person', role: 'owner', status: 'active' }, people: [], deviceOwner: true } };
        if (method === 'viewer.get') return { ...prefs, view: 'now', selectedProjectId: 'p' };
        if (method === 'viewer.put') return args.prefs;
        if (method === 'projects.list') return [{ id: 'p', name: 'Project', kind: 'folder', createdAt: at }];
        if (method === 'threads.list' || method === 'models.list' || method === 'files.list' || method === 'material.list') return [];
        if (method === 'work.now') return { needsYou: [], running: [], progress: [{ threadId: 't', title: 'A task', line: 'I sent the message.', at }], current: [], temporary: [], withdrawn: [], retired: [] };
        return null;
      },
    } });
  }, { prefs: DEFAULT_PREFS });
  await page.goto(url);
  await expect(page.getByTestId('now-progress')).toContainText('Assistant response: I sent the message.');
});


test('recovery copies are inspect-only while ordinary held documents retain their controls', async ({ page }) => {
  await page.addInitScript(({ prefs }) => {
    const at = '2026-11-06T00:00:00Z';
    const version = { n: 1, by: 'agent', at, bytes: 5, sha256: 'fixture' };
    const ordinary = { id: 'held', projectId: 'p', name: 'Held.md', mediaType: 'text/markdown', class: 'working', hidden: true, current: 1, held: { id: 'turn', name: 'source' }, versions: [version] };
    const recovery = { ...ordinary, id: 'recovery', name: 'Recovery.md', recovery: { turnId: 'turn', reason: 'Not imported' } };
    const entries = [ordinary, recovery];
    const needsYou = entries.map((e) => ({ kind: 'held', materialId: e.id, title: e.name, version: 1, lifecycle: 0, detail: e.id === 'recovery' ? 'This saved piece was not imported.' : 'Held for your decision.' }));
    const calls: unknown[] = [];
    const fixture = { calls, failCatalog: true };
    Object.assign(window, { fixture, backbone: {
      platform: 'linux', setTheme() {}, onEvent() { return () => {}; },
      async call(method: string, args: any) {
        if (method === 'host.status') return { owns: true };
        if (method === 'identity.get') return { ok: true, value: { person: { id: 'fixture-person', name: 'Fixture person', role: 'owner', status: 'active' }, people: [], deviceOwner: true } };
        if (method === 'viewer.get') return { ...prefs, view: 'now', selectedProjectId: 'p' };
        if (method === 'viewer.put') return args.prefs;
        if (method === 'projects.list') return [{ id: 'p', name: 'Recovery project', kind: 'folder', createdAt: at }];
        if (method === 'threads.list' || method === 'models.list' || method === 'files.list') return [];
        if (method === 'work.now') return { needsYou, running: [], progress: [], current: [], temporary: [], withdrawn: [], retired: [] };
        if (method === 'material.list') { if (fixture.failCatalog) throw new Error('Catalog unavailable'); return entries; }
        if (method === 'material.read') return { ok: true, value: { entry: entries.find((e) => e.id === args.id), text: 'Saved recovery text' } };
        if (method === 'drafts.get') return null;
        if (method === 'material.lifecycle') { calls.push(args); return { ok: true, value: entries.find((e) => e.id === args.id) }; }
        return null;
      },
    } });
  }, { prefs: DEFAULT_PREFS });
  await page.goto(url);
  const recovery = page.getByTestId('now-needs-you').filter({ hasText: 'Recovery.md' });
  const ordinary = page.getByTestId('now-needs-you').filter({ hasText: 'Held.md' });
  await expect(page.getByText('Document actions are unavailable while details are checked.')).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Allow in later work' })).toHaveCount(0);
  await page.evaluate(() => { (window as any).fixture.failCatalog = false; });
  await page.getByRole('button', { name: 'Retry details' }).click();
  await expect(recovery.getByRole('button', { name: 'Inspect' })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Retire' })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Allow in later work' })).toHaveCount(0);
  await expect(ordinary.getByRole('button', { name: 'Allow in later work' })).toBeVisible();
  await expect(ordinary.getByRole('button', { name: 'Set aside' })).toBeVisible();
  await recovery.getByRole('button', { name: 'Inspect' }).click();
  await expect(page.getByTestId('recovery-copy-notice')).toContainText('not an authorised output');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await recovery.getByRole('button', { name: 'Retire' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls)).toEqual([expect.objectContaining({ id: 'recovery', state: 'retired' })]);
});
