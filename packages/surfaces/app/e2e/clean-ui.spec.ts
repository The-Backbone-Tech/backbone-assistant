// What a person sees is what works: replies read as formatted text, nothing unbuilt is shown as a
// disabled promise, and work starts with full access inside the project. Synthetic transport, no model.
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

const ROADMAP = /Stage \d|later slice|slice \d|Not in the api|not scheduled yet|MCP Extensions/i;

async function open(page: Page) {
  await page.addInitScript(({ prefs }) => {
    const at = '2026-11-02T09:00:00Z';
    const summary = { id: 't', projectId: 'p', title: 'Launch notes', pinned: false, unread: false, archived: false, running: false, updatedAt: at };
    const answer = '## Launch plan\n\nThree steps:\n\n- Draft the **brief**\n- Review it\n- Ship\n\nRun `pnpm check` first.';
    const turn = { id: 'turn', side: false, status: 'done', user: { text: 'Plan the launch', attachments: [], at }, reads: [], work: { startedAt: at, endedAt: at, steps: [], harness: 'controlled' }, answer: { text: answer, files: [] }, effects: [] };
    const side = { id: 'side', user: { text: 'Summarise', at }, answer: { text: '### Summary\n\n1. First\n2. Second' } };
    const thread = { summary, turns: [turn], sideTurns: [side], card: { project: 'Launch', sources: [], changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 } } };
    Object.assign(window, { backbone: {
      platform: 'linux', setTheme() {},
      onEvent() { return () => undefined; },
      async call(method: string) {
        switch (method) {
          case 'identity.get': return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
          case 'viewer.get': return { ...prefs, selectedProjectId: 'p', selectedThreadId: 't' };
          case 'viewer.put': return prefs;
          case 'models.list': return [{ id: 'stub', label: 'Controlled model', efforts: [3] }];
          case 'projects.list': return [{ id: 'p', name: 'Launch', kind: 'folder', createdAt: at }];
          case 'threads.list': return [summary];
          case 'threads.get': return { ok: true, value: thread };
          case 'drafts.get': return null;
          case 'material.list': case 'files.list': return [];
          default: return null;
        }
      },
    } });
  }, { prefs: DEFAULT_PREFS });
  await page.goto(url);
  await expect(page.getByTestId('answer')).toBeVisible();
}

test('a reply reads as formatted text, not raw markdown', async ({ page }) => {
  await open(page);
  const answer = page.getByTestId('answer');
  await expect(answer.getByRole('heading', { name: 'Launch plan' })).toBeVisible();
  await expect(answer.getByRole('listitem')).toHaveCount(3);
  const bold = answer.getByText('brief', { exact: true });
  expect(Number(await bold.evaluate((e) => getComputedStyle(e).fontWeight))).toBeGreaterThanOrEqual(600);
  await expect(answer.locator('code')).toHaveText('pnpm check');
  await expect(answer).not.toContainText('## Launch plan');
});

test('work starts with full access, and nothing unbuilt is offered as a disabled promise', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page);
  await expect(page.getByRole('button', { name: /^Permissions:/ })).toHaveAttribute('aria-label', 'Permissions: Full access');
  await expect(page.locator('body')).not.toContainText(ROADMAP);

  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('menu')).not.toContainText(ROADMAP);
  await expect(page.getByRole('menuitem', { disabled: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText(ROADMAP);
  await expect(dialog.locator('[disabled], [aria-disabled=true], [data-disabled]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.getByTestId('pane')).not.toContainText(ROADMAP);
  expect(errors).toEqual([]);
});

test('a side chat answer reads as formatted text too', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Chat details' }).click();
  await page.getByRole('menuitem', { name: 'New side chat' }).click();
  const side = page.getByTestId('side-chat-tab');
  await expect(side.getByRole('heading', { name: 'Summary' })).toBeVisible();
  await expect(side.locator('.reading').getByRole('listitem')).toHaveCount(2);
  await expect(side).not.toContainText('### Summary');
});
