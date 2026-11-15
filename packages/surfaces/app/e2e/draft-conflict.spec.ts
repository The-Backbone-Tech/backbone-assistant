// Real renderer and bridge, two independent renderers editing the same ordinary draft.
import { expect, test } from '@playwright/test';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { startBridge, stopBridge } from './bridge';
import { api, phase2ProjectAndAttach, phase3Brief } from './journey';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

test('a stale composer keeps local text and can explicitly review the saved draft', async ({page, context}) => {
  const home = freshDataHome('draft-conflict-ui'); const bridge = await startBridge(home); const other = await context.newPage();
  try {
    await page.goto(bridge.url); await other.goto(bridge.url);
    const input = page.getByPlaceholder(/Ask .* anything/), otherInput = other.getByPlaceholder(/Ask .* anything/);
    await expect(input).toBeVisible(); await expect(otherInput).toBeVisible();
    await input.fill('First writer saved');
    await expect.poll(async () => (await api<{text:string} | null>(page, 'drafts.get', {key:'composer:home:none'}))?.text).toBe('First writer saved');
    await otherInput.fill('Second writer local text');
    await expect(other.getByRole('alert')).toContainText(/draft.*changed|draft.*saved/i);
    await expect(otherInput).toHaveValue('Second writer local text');
    await otherInput.press('Enter');
    await expect(other.getByRole('alert')).toContainText('Nothing was sent: this message could not be made safe to retry: Error: This draft changed since it was read. Your unsaved text is still here; review the saved draft before trying again.');
    await expect(otherInput).toHaveValue('Second writer local text');
    expect(await api(page, 'projects.list', {})).toEqual([]);
    const review = other.getByRole('button', {name:'Review saved draft'});
    await expect(review).toBeVisible();
    await review.click();
    await expect(other.getByText('First writer saved', {exact:true})).toBeVisible();
    await expect(otherInput).toHaveValue('Second writer local text');
    const changed = await api<{ok:boolean}>(page, 'drafts.put', {key:'composer:home:none', text:'A third saved revision', clientKey:'third', baseRevision:1});
    expect(changed.ok).toBe(true);
    await other.getByRole('button', {name:'Keep my draft'}).click();
    await expect(other.getByRole('alert')).toContainText(/draft.*changed/i);
    await expect(otherInput).toHaveValue('Second writer local text');
    await expect.poll(async () => (await api<{text:string} | null>(page, 'drafts.get', {key:'composer:home:none'}))?.text).toBe('A third saved revision');
    await other.getByRole('button', {name:'Review saved draft'}).click();
    await expect(other.getByText('A third saved revision', {exact:true})).toBeVisible();
    await other.getByRole('button', {name:'Keep my draft'}).click();
    await expect.poll(async () => (await api<{text:string} | null>(page, 'drafts.get', {key:'composer:home:none'}))?.text).toBe('Second writer local text');
  } finally { await other.close(); await page.close(); await stopBridge(bridge.proc); await removeDataHome(home); }
});


test('a stale file editor preserves its text and can review the saved draft', async ({page, context}) => {
  const home = freshDataHome('draft-file-conflict'); const bridge = await startBridge(home); const other = await context.newPage();
  try {
    await page.goto(bridge.url); await expect(page.locator('[data-ready=true]')).toBeVisible();
    const projectId = await phase2ProjectAndAttach(page); await phase3Brief(page);
    await page.keyboard.press('ControlOrMeta+p'); await page.getByTestId('file-row').filter({hasText:'brief.md'}).click();
    await page.getByRole('button', {name:'Edit', exact:true}).click();
    const editor = page.getByRole('textbox', {name:'Edit brief.md'}); await expect(editor).toBeVisible();
    const entries = await api<{id:string;name:string}[]>(page,'material.list',{projectId}); const id = entries.find(e=>e.name==='brief.md')!.id;
    await other.goto(bridge.url); await expect(other.locator('[data-ready=true]')).toBeVisible();
    await other.keyboard.press('ControlOrMeta+p'); await other.getByTestId('file-row').filter({hasText:'brief.md'}).click();
    const editButton = other.getByRole('button', {name:'Edit',exact:true}); if (await editButton.isEnabled()) await editButton.click();
    const otherEditor = other.getByRole('textbox', {name:'Edit brief.md'}); await expect(otherEditor).toBeVisible();
    await editor.fill('First file draft');
    await expect.poll(async () => (await api<{text:string} | null>(page,'drafts.get',{key:`edit:${id}`}))?.text).toBe('First file draft');
    await otherEditor.fill('Second local file draft');
    await expect(other.getByRole('alert')).toContainText(/draft.*changed|draft.*saved/i);
    await expect(otherEditor).toContainText('Second local file draft');
    await other.getByRole('button', {name:'Close brief.md'}).click();
    await other.keyboard.press('ControlOrMeta+p'); await other.getByTestId('file-row').filter({hasText:'brief.md'}).click();
    await expect(otherEditor).toContainText('Second local file draft');
    await expect(other.getByRole('alert')).toContainText(/confirmed.*draft/i);
    const review = other.getByRole('button',{name:'Review saved draft'}); await expect(review).toBeVisible(); await review.click();
    await expect(other.getByText('First file draft', {exact:true})).toBeVisible();
    await expect(otherEditor).toContainText('Second local file draft');
    const changed = await api<{ok:boolean}>(page,'drafts.put',{key:`edit:${id}`, text:'Third file draft', meta:{baseVersion:1}, clientKey:'third-file', baseRevision:1}); expect(changed.ok).toBe(true);
    await other.getByRole('button',{name:'Keep my draft'}).click();
    await expect(other.getByRole('alert')).toContainText(/draft.*changed/i);
    await expect(otherEditor).toContainText('Second local file draft');
    await other.getByRole('button',{name:'Review saved draft'}).click(); await expect(other.getByText('Third file draft',{exact:true})).toBeVisible();
    await other.getByRole('button',{name:'Keep my draft'}).click();
    await expect.poll(async () => (await api<{text:string} | null>(page,'drafts.get',{key:`edit:${id}`}))?.text).toBe('Second local file draft');
  } finally { await other.close(); await page.close(); await stopBridge(bridge.proc); await removeDataHome(home); }
});

test('a stale side chat keeps its local question and can review the saved draft', async ({page, context}) => {
  const home = freshDataHome('draft-side-conflict'); const bridge = await startBridge(home); const other = await context.newPage();
  try {
    await page.goto(bridge.url); await expect(page.locator('[data-ready=true]')).toBeVisible();
    const projectId = await phase2ProjectAndAttach(page); await phase3Brief(page);
    const threads = await api<{id:string}[]>(page,'threads.list',{projectId}); const id = threads[0].id;
    await page.keyboard.press(process.platform === 'darwin' ? 'Alt+Meta+S' : 'Control+Alt+S');
    const first = page.getByRole('textbox',{name:'Ask the side chat'}); await expect(first).toBeEnabled();
    await expect.poll(async () => (await api<{selectedThreadId?:string}>(page,'viewer.get',{})).selectedThreadId).toBe(id);
    await other.goto(bridge.url); await expect(other.locator('[data-ready=true]')).toBeVisible();
    const second = other.getByRole('textbox',{name:'Ask the side chat'});
    if (!await second.isVisible()) await other.keyboard.press(process.platform === 'darwin' ? 'Alt+Meta+S' : 'Control+Alt+S');
    await expect(second).toBeEnabled();
    await first.fill('First side question');
    await expect.poll(async () => (await api<{text:string} | null>(page,'drafts.get',{key:`side-chat:${id}`}))?.text).toBe('First side question');
    await second.fill('Second local question');
    await expect(other.getByRole('alert')).toContainText(/draft.*saved/i);
    await expect(second).toHaveValue('Second local question');
    const review = other.getByRole('button',{name:'Review saved draft'}); await expect(review).toBeVisible(); await review.click();
    await expect(other.getByText('First side question',{exact:true})).toBeVisible();
    await expect(second).toHaveValue('Second local question');
    const changed = await api<{ok:boolean}>(page,'drafts.put',{key:`side-chat:${id}`, text:'Third side question', clientKey:'third-side', baseRevision:1}); expect(changed.ok).toBe(true);
    await other.getByRole('button',{name:'Keep my draft'}).click();
    await expect(other.getByRole('alert')).toContainText(/draft.*changed/i); await expect(second).toHaveValue('Second local question');
    await other.getByRole('button',{name:'Review saved draft'}).click(); await expect(other.getByText('Third side question',{exact:true})).toBeVisible();
    await other.getByRole('button',{name:'Keep my draft'}).click();
    await expect.poll(async () => (await api<{text:string} | null>(page,'drafts.get',{key:`side-chat:${id}`}))?.text).toBe('Second local question');
  } finally { await other.close(); await page.close(); await stopBridge(bridge.proc); await removeDataHome(home); }
});

test('a saved unconfirmed submission cannot be overwritten and can be adopted explicitly', async ({page, context}) => {
  const home=freshDataHome('draft-pending-send'); const bridge=await startBridge(home); const other=await context.newPage();
  try {
    await page.goto(bridge.url);await other.goto(bridge.url);
    const local=other.getByPlaceholder(/Ask .* anything/);await expect(local).toBeVisible();
    const saved=await api<{ok:boolean}>(page,'drafts.put',{key:'composer:home:none',text:'Earlier request',meta:{sendKey:'existing-identity',sendHow:'selection'},clientKey:'saved-request',baseRevision:0});expect(saved.ok).toBe(true);
    await local.fill('My later local words');await expect(other.getByRole('alert')).toContainText(/draft.*changed/i);
    await other.getByRole('button',{name:'Review saved draft'}).click();await expect(other.getByText('Earlier request',{exact:true})).toBeVisible();
    await expect(other.getByRole('button',{name:'Keep my draft'})).toBeDisabled();
    await other.getByRole('button',{name:'Use saved draft'}).click();await expect(local).toHaveValue('My later local words');
    await other.getByRole('button',{name:'Replace my local draft'}).click();await expect(local).toHaveValue('Earlier request');
    await expect(other.getByText(/earlier route submission is unconfirmed/i)).toBeVisible();
    const current=await api<{text:string;meta:{sendKey:string}}>(page,'drafts.get',{key:'composer:home:none'});expect(current.text).toBe('Earlier request');expect(current.meta.sendKey).toBe('existing-identity');
  } finally {await other.close();await page.close();await stopBridge(bridge.proc);await removeDataHome(home);}
});


test('a fast new chat sends after the previous draft clear answers late', async ({page}) => {
  const home = freshDataHome('draft-clear-order'); const bridge = await startBridge(home);
  const releaseClear = deferred();
  const clearStarted = deferred();
  const releaseFallback = deferred();
  const fallbackStarted = deferred();
  try {
    await page.goto(bridge.url); await expect(page.locator('[data-ready=true]')).toBeVisible();
    const project = await api<{value:{id:string}}>(page, 'projects.create', {name:'Launch',kind:'folder'});
    await page.getByRole('navigation').getByRole('button', { name: 'Launch', exact: true }).click();
    const message = page.getByRole('textbox', {name:'Message'});
    await expect(message).toBeEnabled();
    const key = `composer:home:${project.value.id}`;
    let clearing = false;
    await page.route('**/api', async route => {
      const {method,args} = route.request().postDataJSON();
      if (method === 'drafts.put' && args.key === key && args.text === '') {
        clearing = true;
        const response = await route.fetch();
        clearStarted.resolve();
        await releaseClear.promise;
        await route.fulfill({response});
      } else if (clearing && method === 'drafts.get' && args.key === 'composer:home:none') {
        fallbackStarted.resolve();
        await releaseFallback.promise;
        await route.continue();
      } else await route.continue();
    });
    await message.fill('First'); await message.press('Enter');
    await expect(page.getByTestId('turn')).toHaveCount(1);
    await clearStarted.promise;
    await page.getByRole('button', {name:'New chat'}).click();
    await expect(page.getByRole('heading', {name:/What should we work on in Launch/})).toBeVisible();
    await fallbackStarted.promise;
    const answered = page.waitForResponse(async response => {
      if (!response.url().endsWith('/api') || response.request().method() !== 'POST') return false;
      const body = response.request().postDataJSON();
      return body.method === 'drafts.put' && body.args.key === key && body.args.text === '';
    });
    releaseClear.resolve(); await (await answered).finished();
    // A bridge round trip lets the renderer apply the clear before its fallback read returns.
    await api(page, 'drafts.get', {key});
    releaseFallback.resolve();
    await message.fill('Second'); await message.press('Enter');
    await expect(page.getByRole('tab', {name:/Second/}).or(page.getByRole('alert'))).toBeVisible();
    expect(await page.getByRole('alert').allTextContents()).toEqual([]);
    await expect(page.getByRole('tab', {name:/Second/})).toHaveAttribute('aria-selected','true');
    await expect(page.getByTestId('turn').first()).toContainText('Second');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(async () => (await api<{id:string}[]>(page,'threads.list',{projectId:project.value.id})).length).toBe(2);
  } finally {
    releaseClear.resolve(); releaseFallback.resolve();
    await page.close(); await stopBridge(bridge.proc); await removeDataHome(home);
  }
});
