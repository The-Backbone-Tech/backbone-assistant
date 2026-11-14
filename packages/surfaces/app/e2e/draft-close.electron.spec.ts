import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
import { expect, test, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { api, appDir } from './journey';

const executablePath = createRequire(import.meta.url)('electron') as string;
test('quit preserves an unconfirmed local draft in a separate reviewable copy', async () => {
  const home = freshDataHome('conflict-close-native');
  let app: ElectronApplication | undefined;
  const launch = async () => {
    const instance = await _electron.launch({ executablePath, args: [appDir], env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-stub', BACKBONE_MODEL_ENDPOINT: '' } });
    const page = await instance.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible({timeout:TEST_HANG_MS});
    return {instance, page};
  };
  try {
    let current = await launch(); app = current.instance;
    const input = current.page.getByPlaceholder(/Ask .* anything/); await expect(input).toBeEnabled();
    const result = await api<{ok:boolean}>(current.page, 'drafts.put', {key:'composer:home:none',text:'Other saved words',clientKey:'other',baseRevision:0}); expect(result.ok).toBe(true);
    await input.fill('My unconfirmed local words');
    await expect(current.page.getByRole('alert')).toContainText(/draft.*changed/i);
    const closed = app.waitForEvent('close'); await app.evaluate(({app}) => {setImmediate(() => app.quit());}); await closed; app = undefined;
    current = await launch(); app = current.instance;
    await expect(current.page.getByPlaceholder(/Ask .* anything/)).toHaveValue('Other saved words');
    await current.page.getByRole('button',{name:'Review conflict copy'}).click();
    await expect(current.page.getByText('My unconfirmed local words',{exact:true})).toBeVisible();
    await current.page.getByRole('button',{name:'Discard conflict copy'}).click();
    await current.page.getByRole('button',{name:'Discard this copy'}).click();
    await expect(current.page.getByRole('button',{name:'Review conflict copy'})).toHaveCount(0);
  } finally {
    if (app) { const child=app.process(); if (child.exitCode===null && child.signalCode===null) {const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve())); child.kill('SIGKILL'); await exited;} }
    await removeDataHome(home);
  }
});

test('a failed conflict copy keeps the window open until the person explicitly accepts the loss', async () => {
  const home = freshDataHome('conflict-close-failure');
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath, args: [appDir], env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-stub', BACKBONE_MODEL_ENDPOINT: '' } });
    const page = await app.firstWindow(); await expect(page.locator('[data-ready=true]')).toBeVisible({timeout:TEST_HANG_MS});
    const input = page.getByPlaceholder(/Ask .* anything/); await expect(input).toBeEnabled();
    const saved = await api<{ok:boolean}>(page,'drafts.put',{key:'composer:home:none',text:'Saved elsewhere',clientKey:'other',baseRevision:0}); expect(saved.ok).toBe(true);
    await input.fill('Local words at risk'); await expect(page.getByRole('alert')).toContainText(/draft.*changed/i);
    chmodSync(join(home,'drafts'),0o500);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
    await expect(page.getByText(/Closing without copies loses their local text/)).toBeVisible();
    await expect(input).toHaveValue('Local words at risk');
    const closed = page.waitForEvent('close'); await page.getByRole('button',{name:'Close without these copies'}).click(); await closed;
  } finally {
    try {chmodSync(join(home,'drafts'),0o700);} catch {}
    if (app) {const child=app.process(); if (child.exitCode===null && child.signalCode===null) {const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve())); child.kill('SIGKILL'); await exited;}}
    await removeDataHome(home);
  }
});

test('the View menu reload drains a conflicted draft to a copy before reloading', async () => {
  const home=freshDataHome('conflict-reload-native'); let app:ElectronApplication|undefined;
  try {
    app=await _electron.launch({executablePath,args:[appDir],env:{...process.env,BACKBONE_HOME:home,BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'harness-stub',BACKBONE_MODEL_ENDPOINT:''}});
    const page=await app.firstWindow(); await expect(page.locator('[data-ready=true]')).toBeVisible({timeout:TEST_HANG_MS});
    const input=page.getByPlaceholder(/Ask .* anything/); await expect(input).toBeEnabled();
    const saved=await api<{ok:boolean}>(page,'drafts.put',{key:'composer:home:none',text:'Saved before reload',clientKey:'other',baseRevision:0}); expect(saved.ok).toBe(true);
    await input.fill('Local before reload'); await expect(page.getByRole('alert')).toContainText(/draft.*changed/i);
    const loaded=page.waitForEvent('load',{timeout:TEST_HANG_MS}); await app.evaluate(({Menu,BrowserWindow})=>{const item=Menu.getApplicationMenu()!.getMenuItemById('safe-reload')!;item.click(item,BrowserWindow.getAllWindows()[0],{} as any);}); await loaded;
    await expect(page.getByPlaceholder(/Ask .* anything/)).toHaveValue('Saved before reload');
    await page.getByRole('button',{name:'Review conflict copy'}).click(); await expect(page.getByText('Local before reload',{exact:true})).toBeVisible();
  } finally {if(app){const child=app.process();if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;}} await removeDataHome(home);}
});

test('reload remains on the current page when its conflict copy fails', async () => {
  const home=freshDataHome('conflict-reload-failure');let app:ElectronApplication|undefined;
  try {
    app=await _electron.launch({executablePath,args:[appDir],env:{...process.env,BACKBONE_HOME:home,BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'harness-stub',BACKBONE_MODEL_ENDPOINT:''}});
    const page=await app.firstWindow(); await expect(page.locator('[data-ready=true]')).toBeVisible({timeout:TEST_HANG_MS});
    const input=page.getByPlaceholder(/Ask .* anything/);await expect(input).toBeEnabled();
    const saved=await api<{ok:boolean}>(page,'drafts.put',{key:'composer:home:none',text:'Saved elsewhere',clientKey:'other',baseRevision:0});expect(saved.ok).toBe(true);
    await input.fill('Local before failed reload');await expect(page.getByRole('alert')).toContainText(/draft.*changed/i);
    chmodSync(join(home,'drafts'),0o500);await app.evaluate(({Menu,BrowserWindow})=>{const item=Menu.getApplicationMenu()!.getMenuItemById('safe-reload')!;item.click(item,BrowserWindow.getAllWindows()[0],{} as any);});
    await expect(page.getByText(/Closing without copies loses their local text/)).toBeVisible();await expect(input).toHaveValue('Local before failed reload');
    await page.getByRole('button',{name:'Keep window open'}).click();await expect(input).toHaveValue('Local before failed reload');
  } finally {try{chmodSync(join(home,'drafts'),0o700);}catch{} if(app){const child=app.process();if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;}}await removeDataHome(home);}
});

test('native F5 reload drains a conflicted draft first', async () => {
  const home=freshDataHome('conflict-f5-native');let app:ElectronApplication|undefined;
  try {
    app=await _electron.launch({executablePath,args:[appDir],env:{...process.env,BACKBONE_HOME:home,BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'harness-stub',BACKBONE_MODEL_ENDPOINT:''}});
    const page=await app.firstWindow();await expect(page.locator('[data-ready=true]')).toBeVisible({timeout:TEST_HANG_MS});
    const input=page.getByPlaceholder(/Ask .* anything/);await expect(input).toBeEnabled();
    const saved=await api<{ok:boolean}>(page,'drafts.put',{key:'composer:home:none',text:'Saved before F5',clientKey:'other',baseRevision:0});expect(saved.ok).toBe(true);
    await input.fill('Local before F5');await expect(page.getByRole('alert')).toContainText(/draft.*changed/i);
    const loaded=page.waitForEvent('load',{timeout:TEST_HANG_MS});await app.evaluate(({BrowserWindow})=>{const contents=BrowserWindow.getAllWindows()[0].webContents;contents.sendInputEvent({type:'keyDown',keyCode:'F5'});contents.sendInputEvent({type:'keyUp',keyCode:'F5'});});await loaded;
    await page.getByRole('button',{name:'Review conflict copy'}).click();await expect(page.getByText('Local before F5',{exact:true})).toBeVisible();
  } finally {if(app){const child=app.process();if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;}}await removeDataHome(home);}
});
