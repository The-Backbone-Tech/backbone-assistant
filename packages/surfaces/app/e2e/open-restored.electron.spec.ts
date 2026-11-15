// Real restore and second process. Only native pickers and child debugging are replaced by the fixture.
import { stopFixtureChildren } from './folder-child-cleanup';
import { _electron, chromium, expect, test, type Browser, type ElectronApplication } from '@playwright/test';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, appDir, repoRoot } from './journey';

async function unusedPort() {
  const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;
}
test('restore opens a second instance on the restored folder and keeps the first on its own folder',async()=>{
  const home=freshDataHome('open-restored');
  const scratch=realpathSync(mkdtempSync(join(tmpdir(),'open-restored-')));
  const backup=join(scratch,'export');mkdirSync(join(backup,'projects/p001'),{recursive:true});
  const files={'README.md':'A small test export.','projects/p001/project.json':JSON.stringify({name:'Restored harbor',kind:'folder'})};
  for(const [name,text] of Object.entries(files))writeFileSync(join(backup,name),text);
  const counts={projects:1,documents:0,versions:0,threads:0,memoryFiles:0,skills:0,receipts:0,unresolved:0};
  writeFileSync(join(backup,'manifest.json'),JSON.stringify({format:'home-export',version:4,id:'open-restored',createdAt:new Date().toISOString(),counts,excluded:[],scrubbed:0,files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')]))}));
  let app:ElectronApplication|undefined;
  let target='';let childBrowser:Browser|undefined;
  try{
    app=await _electron.launch({args:[appDir],env:{...process.env,BACKBONE_HOME:home,BACKBONE_USER_HOME:'',BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'harness-pi',BACKBONE_IDENTITY_ISSUER:''}});
    const page=await app.firstWindow();await expect(page.locator('[data-ready=true]')).toBeVisible();
    const port=await unusedPort();
    await app.evaluate(async({dialog}, {backup,port})=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[backup]});
      const cp=process.getBuiltinModule('node:child_process') as typeof import('node:child_process');const original=cp.spawn;
      cp.spawn=((exe:string,args:string[],options:import('node:child_process').SpawnOptions)=>{
        if(exe!==process.execPath||!Array.isArray(options.stdio)||!options.stdio.includes('ipc'))return original(exe,args,options);
        // Keep this fixture away from the machine's signed-in native client; no model is called.
        const child=original(exe,[...args,`--remote-debugging-port=${port}`],{...options,env:{...options.env,BACKBONE_HARNESS:'harness-pi'}});
        const state=globalThis as unknown as {restoredChildren:import('node:child_process').ChildProcess[]};
        (state.restoredChildren??=[]).push(child);return child;
      }) as typeof original;
    },{backup,port});
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    const settings=page.getByRole('dialog',{name:'Settings'});
    await settings.getByRole('button',{name:'Backup',exact:true}).click();
    await settings.getByRole('button',{name:'Restore from a backup…'}).click();
    const dialog=page.getByTestId('restore-dialog');
    await dialog.getByRole('button',{name:'Choose backup folder…'}).click();
    await dialog.getByRole('button',{name:'Choose where it goes'}).click();
    await expect(dialog.getByTestId('restore-place')).toContainText('-restored-');
    target=(await dialog.getByTestId('restore-place').textContent())!;
    await dialog.getByRole('button',{name:'Restore',exact:true}).click();
    await expect(dialog.locator('[data-testid=restore-done], [data-testid=restore-refused], [data-testid=restore-unknown]')).toBeVisible();
    expect(await dialog.getByTestId('restore-done').count(),await dialog.innerText()).toBe(1);
    await expect(dialog.getByTestId('restore-done')).toBeVisible();
    const shots=join(process.env.BACKBONE_OPEN_RESTORED_SHOTS??join(repoRoot,'evidence/open-restored'),'electron');mkdirSync(shots,{recursive:true});
    await page.screenshot({path:join(shots,'restored-before-opening.png')});
    const open=dialog.getByRole('button',{name:'Open the restored folder',exact:true});
    await open.focus();await expect(open).toBeFocused();await open.press('Enter');
    await expect(dialog.getByText('Opened in another window.',{exact:false})).toBeVisible();
    childBrowser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const child=childBrowser.contexts()[0].pages().find(p=>p.url().startsWith('file:'))!;
    await expect(child.locator('[data-ready=true]')).toBeVisible();
    // The native window title is separate from document.title; General proves the child's visible path.
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle())).toContain(home);
    const childInfo=await child.evaluate(()=>window.backbone!.appInfo!());expect(childInfo.dataFolder).toBe(target);
    const firstInfo=await page.evaluate(()=>window.backbone!.appInfo!());expect(firstInfo.dataFolder).toBe(home);
    expect(await api<{name:string}[]>(child,'projects.list',{})).toEqual(expect.arrayContaining([expect.objectContaining({name:'Restored harbor'})]));
    expect(await api<{name:string}[]>(page,'projects.list',{})).toEqual([]);
    await child.getByRole('button',{name:'Settings',exact:true}).click();
    await expect(child.getByTestId('current-data-folder')).toContainText(target);
    await child.screenshot({path:join(shots,'restored-folder-in-general.png')});
    expect((await app.evaluate(()=>({pid:(globalThis as unknown as {restoredChildren:{pid:number}[]}).restoredChildren[0].pid}))).pid).not.toBe(app.process().pid);
    await child.getByRole('dialog',{name:'Settings'}).getByRole('button',{name:'Done',exact:true}).click();
    await dialog.getByRole('button',{name:'Done',exact:true}).click();
    // The export itself is not a data folder and is refused by the real Main preflight.
    await settings.getByRole('button',{name:'Open another data folder…'}).click();
    await expect(settings.getByRole('alert')).toContainText('first run did not finish');
    // A second launch for either existing app uses the same Electron per-folder lock.
    for(const folder of [target,home]){
      await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},folder);
      await settings.getByRole('button',{name:'Open another data folder…'}).click();
      await settings.getByRole('button',{name:'Open this data folder'}).click();
      await expect(settings.getByText(folder===home?'This data folder is the folder this window already shows.':'This data folder is already open',{exact:false})).toBeVisible();
      await expect(child.locator('[data-ready=true]')).toBeVisible();
      expect((await page.evaluate(()=>window.backbone!.appInfo!())).dataFolder).toBe(home);
    }
    if(process.platform==='darwin'){
      // Closing a window keeps its menu-bar app alive. A later open must recover that window too.
      const context=childBrowser.contexts()[0];await child.close();
      await expect.poll(()=>context.pages().filter(p=>p.url().startsWith('file:')).length).toBe(0);
      const reopened=context.waitForEvent('page');
      await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},target);
      await settings.getByRole('button',{name:'Open another data folder…'}).click();
      await settings.getByRole('button',{name:'Open this data folder'}).click();
      await expect((await reopened).locator('[data-ready=true]')).toBeVisible();
      await expect(settings.getByText('This data folder is already open',{exact:false})).toBeVisible();
    }
  }finally{
    await childBrowser?.close();
    const cleanup = await app?.evaluate(stopFixtureChildren, 10_000).catch(error => error as Error);
    await app?.close();
    if(target)await removeDataHome(target);
    await removeDataHome(home);rmSync(scratch,{recursive:true,force:true});
    if (cleanup instanceof Error) throw cleanup;
  }
});

test('a plaintext command-style folder shows its original key refusal without workspace sign-in',async()=>{
  const home=freshDataHome('open-restored-foreign');
  let app:ElectronApplication|undefined;
  try{
    // As in the installed app, select Keychain keys. The plaintext vault refuses before any
    // Keychain encryption or decryption, so this test never reaches a person's Keychain.
    app=await _electron.launch({args:[appDir],env:{...process.env,BACKBONE_HOME:home,BACKBONE_USER_HOME:'',BACKBONE_KEYS:'',BACKBONE_HARNESS:'harness-pi',BACKBONE_IDENTITY_ISSUER:''}});
    const page=await app.firstWindow();
    await expect(page.locator('[data-startup-failed=true]')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('plain files',{timeout:5000});
    await expect(page.getByTestId('startup-data-folder')).toContainText(home);
    await expect(page.getByRole('alert')).toContainText('command that created it');
    await expect(page.getByRole('heading',{name:'Workspace sign-in'})).toHaveCount(0);
    await expect(page.getByText('Quit and open the app again to retry.')).toHaveCount(0);
    const problem=await page.evaluate(()=>window.backbone!.dataFolderStatus!());
    expect(problem?.kind).toBe('keys');
    const shots=join(process.env.BACKBONE_OPEN_RESTORED_SHOTS??join(repoRoot,'evidence/open-restored'),'electron');mkdirSync(shots,{recursive:true});
    await page.screenshot({path:join(shots,'plaintext-folder-refused.png')});
  }finally{await app?.close();await removeDataHome(home);}
});
