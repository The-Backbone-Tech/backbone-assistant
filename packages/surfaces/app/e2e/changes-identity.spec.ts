// Actual diff components and AppProvider; delayed transport observes request ownership, not diff correctness.
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
let server: ViteDevServer; let url: string;
test.beforeAll(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: fileURLToPath(new URL('../node_modules/.vite-changes-identity', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'changes-component-fixture',
    transformIndexHtml: (html) => html.replace('/src/main.tsx', '/changes-fixture.tsx'),
    resolveId: (id) => id === '/changes-fixture.tsx' ? '\0changes-fixture.tsx' : undefined,
    load: (id) => id === '\0changes-fixture.tsx' ? `import React from 'react'; import {createRoot} from 'react-dom/client'; import {AppProvider} from '/src/lib/state.tsx'; import {ChangesTab,VersionChanges} from '/src/components/tabs/ChangesTab.tsx';
      function Fixture(){const [v,set]=React.useState({projectId:'p',threadId:'a',version:1,materialId:'m',mode:'scope'});window.fixture.view=(patch)=>set(v=>({...v,...patch}));return v.mode==='scope'?React.createElement(ChangesTab,{projectId:v.projectId,threadId:v.threadId}):React.createElement(VersionChanges,{projectId:v.projectId,materialId:v.materialId,version:v.version})};createRoot(document.getElementById('root')).render(React.createElement(AppProvider,null,React.createElement(Fixture)));` : undefined,
  }] });
  await server.listen(); url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const f = { hold: false, fail: false, pending: [] as { args: any; release: () => void }[], view: (_: any) => {} };
    Object.assign(window, { fixture: f, backbone: { platform: 'linux', setTheme() {}, onEvent() { return () => {}; }, async call(method: string, args: any) {
      switch (method) {
          case 'identity.get': return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
        case 'host.status': return { owns: true };
        case 'viewer.get': return { theme: 'light', pane: { open: false, tabs: [] } };
        case 'viewer.put': return args.prefs;
        case 'projects.list': return ['p','q','r'].map((id) => ({ id, name: id, kind: 'git', createdAt: new Date().toISOString() }));
        case 'models.list': case 'threads.list': return [];
        case 'changes.get': {
          if (f.hold) await new Promise<void>((release) => f.pending.push({ args, release }));
          if (f.fail) throw new Error('Controlled read failure');
          const label = args.version ? `${args.projectId}-${args.version.materialId}-v${args.version.version}` : `${args.projectId}-${args.threadId}-${args.scope}-${args.base ?? 'parent'}`;
          return { ok: true, value: { base: args.base ?? 'parent', bases: ['parent','main'], files: [{ path: label + '.txt', patch: '@@ -0,0 +1 @@\n+' + label, added: 1, removed: 0 }] } };
        }
        default: return null;
      }
    } } });
  });
  await page.goto(url);
  await expect(page.getByRole('heading', { name: /p-a-last-turn-parent.txt/ })).toBeVisible();
});

test('new scope and base hide the previous diff while their read is pending', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.hold = true; });
  await page.getByRole('radio', { name: 'Unstaged', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Loading changes…');
  await expect(page.getByRole('heading', { name: /p-a-last-turn/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).fixture.pending.length)).toBe(1);
  await page.evaluate(() => (window as any).fixture.pending.shift().release());
  await expect(page.getByRole('heading', { name: /p-a-unstaged-parent/ })).toBeVisible();
  await page.getByRole('combobox', { name: 'Base', exact: true }).selectOption('main');
  await expect(page.getByRole('heading', { name: /p-a-unstaged-parent/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).fixture.pending.length)).toBe(1);
  await page.evaluate(() => (window as any).fixture.pending.shift().release());
  await expect(page.getByRole('heading', { name: /p-a-unstaged-main/ })).toBeVisible();
});

test('a late project/thread response cannot replace the newer view', async ({ page }) => {
  await page.evaluate(() => { const f = (window as any).fixture; f.hold = true; f.view({ projectId: 'q', threadId: 'b' }); });
  await expect(page.getByRole('heading', { name: /p-a-last-turn/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).fixture.pending.length)).toBe(1);
  await page.evaluate(() => { const f = (window as any).fixture; f.hold = false; f.view({ projectId: 'r', threadId: 'c' }); });
  await expect(page.getByRole('heading', { name: /r-c-last-turn-parent/ })).toBeVisible();
  await page.evaluate(() => (window as any).fixture.pending.shift().release());
  await expect(page.getByRole('heading', { name: /r-c-last-turn-parent/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /q-b-last-turn/ })).toHaveCount(0);
});

test('version and material labels never carry the preceding patch', async ({ page }) => {
  await page.evaluate(() => (window as any).fixture.view({ mode: 'version' }));
  const view = page.getByTestId('version-changes');
  await expect(view).toContainText('p-m-v1');
  await page.evaluate(() => { const f = (window as any).fixture; f.hold = true; f.view({ version: 2 }); });
  await expect(view).not.toContainText('p-m-v1');
  await expect(view.getByRole('status')).toHaveText('Loading changes…');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.pending.length)).toBe(1);
  await page.evaluate(() => (window as any).fixture.pending.shift().release());
  await expect(view).toContainText('p-m-v2');
  await page.evaluate(() => (window as any).fixture.view({ materialId: 'n', version: 1 }));
  await expect(view).not.toContainText('p-m-v2');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.pending.length)).toBe(1);
  await page.evaluate(() => (window as any).fixture.pending.shift().release());
  await expect(view).toContainText('p-n-v1');
});

test('a failed read shows an error and retry, with no previous-scope content', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.fail = true; });
  await page.getByRole('radio', { name: 'Unstaged', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Changes could not be loaded');
  await expect(page.getByRole('heading', { name: /p-a-last-turn/ })).toHaveCount(0);
  await page.evaluate(() => { (window as any).fixture.fail = false; });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: /p-a-unstaged-parent/ })).toBeVisible();
});
