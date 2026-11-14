// Real app navigation, synthetic transport: drafts and receipts belong to their original side chat.
import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
let server: ViteDevServer; let url: string;
test.beforeAll(async () => { server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } }); await server.listen(); url = server.resolvedUrls!.local[0]; });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const at = new Date().toISOString();
    const summaries = ['a','b'].map((id) => ({ id, projectId: 'p', title: `Thread ${id.toUpperCase()}`, running: false, createdAt: at, updatedAt: at }));
    const prefs = { theme: 'light', selectedProjectId: 'p', selectedThreadId: 'a', pane: { open: true, tabs: [{ id: 'side-chat', kind: 'side-chat' }], active: 'side-chat' } };
    const saved = JSON.parse(sessionStorage.getItem('sidechat-fixture') ?? '{"drafts":{}}');
    const f = { drafts: saved.drafts, sideTurns: saved.sideTurns ?? [], calls: [] as any[], hold: false, mode: 'ok', release: () => {}, failSave: false, holdDraft: saved.holdDraft ?? false, waitingDraft: false, releaseDraft: () => {} };
    const save = () => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ drafts: f.drafts, sideTurns: f.sideTurns }));
    Object.assign(window, { fixture: f, backbone: { platform: 'linux', setTheme() {}, onEvent() { return () => {}; }, async call(method: string, args: any) {
      switch (method) {
          case 'identity.get': return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
        case 'host.status': return { owns: true };
        case 'viewer.get': return prefs;
        case 'viewer.put': return args.prefs;
        case 'projects.create': f.calls.push({ method, args }); if (f.mode === 'lost') throw new Error('controlled lost response'); if (f.mode === 'refused') return {ok:false,outcome:'REFUSED',reason:'PROJECT_CREATE_FAILED',detail:'Project was not created.'}; if (f.mode === 'gate') return {ok:false,outcome:'REFUSED',reason:'NOT_AVAILABLE',detail:'This data home was opened read-only.'}; if (f.mode === 'unknown') return {ok:false,outcome:'UNKNOWN',reason:'NOT_AVAILABLE',detail:'Inspect any files at /example/partial-project.'}; await new Promise<void>((r) => { f.release = r; }); return { ok: true, value: { id: 'new' } };
        case 'projects.list': return [{ id: 'p', name: 'Side-chat fixture', kind: 'folder', createdAt: at }];
        case 'threads.list': return summaries;
        case 'threads.get': return { ok: true, value: { summary: summaries.find((t) => t.id === args.id), turns: [], sideTurns: args.id === 'a' ? f.sideTurns : [], card: { project: 'Side-chat fixture', sources: [], changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 } } } };
        case 'models.list': return [{ id: 'stub', label: 'Controlled', efforts: [3] }];
        case 'plugins.parts': case 'files.list': case 'material.list': return [];
        case 'drafts.get':
          if (f.holdDraft && args.key === 'side-chat:a') {
            f.waitingDraft = true;
            const captured = structuredClone(f.drafts[args.key] ?? null);
            await new Promise<void>((r) => { f.releaseDraft = r; });
            return captured;
          }
          return f.drafts[args.key] ?? null;
        case 'drafts.put': { if (f.failSave) throw new Error('Controlled save failure'); const prior=f.drafts[args.key]; if (args.baseRevision !== (prior?.revision ?? 0)) return {ok:false,reason:'STALE_BASE',detail:'Draft changed.'}; f.drafts[args.key] = { ...args, revision:(prior?.revision ?? 0)+1, updatedAt: at }; save(); return { ok: true, value: f.drafts[args.key] }; }
        case 'sidechat.ask':
          f.calls.push(structuredClone(args));
          if (f.hold) await new Promise<void>((r) => { f.release = () => { f.hold = false; r(); }; });
          if (f.mode === 'lost') throw new Error('Controlled response loss');
          if (f.mode === 'pending') return { ok: true, value: { status: 'stopped', sideRecoveryPending: true } };
          return f.mode === 'refused' ? { ok: false, reason: 'NOT_FOUND', outcome: 'REFUSED', detail: 'Thread no longer exists.' } : { ok: true, value: {} };
        case 'sidechat.stop': f.calls.push({ method, ...args }); return { ok: true, value: { stopped: true } };
        default: return null;
      }
    } } });
  });
  await page.goto(url); await expect(side(page)).toBeEnabled();
});
const side = (page: Page) => page.getByRole('textbox', { name: 'Ask the side chat', exact: true });
const select = (page: Page, letter: string) => page.getByRole('navigation').getByRole('button', { name: `Thread ${letter}`, exact: true }).click();


test('a delayed project creation submits once even after closing and reopening', async ({ page }) => {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Synthetic project');
  await page.getByRole('button', { name: 'Create project' }).dblclick();
  await expect(page.getByRole('button', { name: 'Creating…' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: 'Creating…' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await page.evaluate(() => (window as any).fixture.release());
  await expect(page.getByRole('dialog', { name: 'New project' })).toHaveCount(0);
});

test('a lost response preserves the name and says the outcome is unknown', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.mode = 'lost'; });
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Synthetic project');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByRole('alert')).toContainText('saved attempt');
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Synthetic project');
  expect(await page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
});

test('a lost response is checked with the same identity after reopening', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.mode='lost'; });
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('textbox',{name:'Name'}).fill('Keep this identity');
  await page.getByRole('button',{name:'Create project'}).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  const first=await page.evaluate(()=>(window as any).fixture.calls[0].args.clientKey);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'New project'}).click();
  await expect(page.getByRole('button',{name:'Check again'})).toBeEnabled();
  await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  const calls=await page.evaluate(()=>(window as any).fixture.calls);
  expect(calls).toHaveLength(2);expect(calls[1].args.clientKey).toBe(first);
});

test('failure to persist an attempt dispatches no project creation', async ({page}) => {
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('textbox',{name:'Name'}).fill('Not dispatched');
  await page.evaluate(()=>{(window as any).fixture.failSave=true;});
  await page.getByRole('button',{name:'Create project'}).click();
  await expect(page.getByRole('alert')).toContainText('No project was sent');
  expect(await page.evaluate(()=>(window as any).fixture.calls)).toHaveLength(0);
});

test('a definitive refusal unlocks the fields and clears the saved attempt', async ({page}) => {
  await page.evaluate(()=>{(window as any).fixture.mode='refused';});
  await page.getByRole('button',{name:'New project'}).click();await page.getByRole('textbox',{name:'Name'}).fill('Refused project');
  await page.getByRole('button',{name:'Create project'}).click();await expect(page.getByRole('alert')).toContainText('Project was not created');
  await expect(page.getByRole('textbox',{name:'Name'})).toBeEnabled();await expect(page.getByRole('button',{name:'Create project'})).toBeEnabled();
  const draft=await page.evaluate(()=>(window as any).fixture.drafts['project-create:intent']);expect(draft.text).toBe('');
});

test('leaving an unknown attempt requires explicit acknowledgement', async ({page}) => {
  await page.evaluate(()=>{(window as any).fixture.mode='unknown';});
  await page.getByRole('button',{name:'New project'}).click();await page.getByRole('textbox',{name:'Name'}).fill('Leave for inspection');
  await page.getByRole('button',{name:'Create project'}).click();await expect(page.getByRole('alert')).toContainText('/example/partial-project');
  await page.getByRole('button',{name:'Leave files and forget attempt'}).click();
  await expect(page.getByText(/may still exist or finish later/)).toBeVisible();
  await page.getByRole('button',{name:'Leave files and forget',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Name'})).toBeEnabled();
  const draft=await page.evaluate(()=>(window as any).fixture.drafts['project-create:intent']);expect(draft.text).toBe('');
});

test('a general read-only refusal never forgets an earlier unknown attempt', async ({page}) => {
  await page.evaluate(()=>{(window as any).fixture.mode='lost';});
  await page.getByRole('button',{name:'New project'}).click();await page.getByRole('textbox',{name:'Name'}).fill('Earlier attempt');
  await page.getByRole('button',{name:'Create project'}).click();await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  const before=await page.evaluate(()=>(window as any).fixture.drafts['project-create:intent'].text);
  await page.evaluate(()=>{(window as any).fixture.mode='gate';});await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByRole('button',{name:'Check again'})).toBeEnabled();await expect(page.getByRole('textbox',{name:'Name'})).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).fixture.drafts['project-create:intent'].text)).toBe(before);
});

test('reopened unknown attempt must be checked before it can be left', async ({page}) => {
  await page.evaluate(()=>{(window as any).fixture.mode='lost';});
  await page.getByRole('button',{name:'New project'}).click();await page.getByRole('textbox',{name:'Name'}).fill('Pending inspection');
  await page.getByRole('button',{name:'Create project'}).click();await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'New project'}).click();
  await expect(page.getByRole('button',{name:'Check again'})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Leave files and forget attempt'})).toHaveCount(0);
  await page.evaluate(()=>{(window as any).fixture.mode='unknown';});await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByRole('alert')).toContainText('/example/partial-project');await expect(page.getByRole('button',{name:'Leave files and forget attempt'})).toBeVisible();
});
