// Real renderer, synthetic main port. Native launch and real restoration have a separate Electron journey.
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { DEFAULT_PREFS } from '@backbone-next/platform';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { repoRoot } from './journey';
let server:ViteDevServer,url:string;
test.beforeAll(async()=>{server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0}});await server.listen();url=server.resolvedUrls!.local[0];});
test.afterAll(async()=>{await server?.close();});

test('opening states and recovery in Backup',async({page},info)=>{
  const dir=join(process.env.BACKBONE_OPEN_RESTORED_SHOTS??join(repoRoot,'evidence/open-restored'),info.project.name);mkdirSync(dir,{recursive:true});
  await page.addInitScript(prefs=>{
    const fixture={state:'starting',calls:0,badPick:false};
    Object.assign(window,{folderFixture:fixture,backbone:{
      appInfo:async()=>({packaged:false,version:'0',dataFolder:'/data/Current work'}),
      platform:'linux',setTheme(){},onEvent(){return()=>{};},
      chooseDataFolder:async()=>fixture.badPick?{ok:false,reason:'INVALID',detail:'This is not a finished data folder.'}:{ok:true,id:'picked-by-main',folder:'/data/Restored work'},
      async restoreBackup(request:{step:string;id?:string}){
        if(request.step==='view')return {availability:{available:true},currentFolder:'/data/Current work',job:{state:'done',openId:'restored-by-main',target:'/data/Restored work',from:'/backups/export',finishedAt:new Date().toISOString(),counts:{},adds:{},skipped:[]}};
        if(request.step==='open'){
          if(!['picked-by-main','restored-by-main'].includes(request.id??''))throw new Error('Unexpected id');fixture.calls++;
          if(fixture.state==='starting')await new Promise(r=>setTimeout(r,1200));
          if(fixture.state==='current')return {state:'already-open',current:true};
          if(fixture.state==='expired')return {state:'failed',detail:'That choice expired. Use “Open another data folder…” to choose it again.'};
          return fixture.state==='failed'?{state:'failed',detail:'This build cannot open this data version.'}:fixture.state==='unknown'?{state:'unknown',detail:'No confirmation from the other window.'}:{state:fixture.state==='starting'?'opened':fixture.state};
        }
        return {availability:{available:true},currentFolder:'/data/Current work',job:null};
      },
      async call(method:string,args:any){
        if(method==='host.status')return {owns:true};
        if(method==='settings.policy.get')return {state:'none'};
        if(method==='viewer.get')return {...prefs,pane:{open:false,tabs:[]}};
        if(method==='viewer.put')return args.prefs;
        if(method==='identity.get')return {ok:true,value:{person:{id:'owner',name:'Owner',role:'owner',status:'active'},people:[],deviceOwner:true}};
        if(['projects.list','threads.list','models.list','plugins.parts','material.list','files.list'].includes(method))return [];
        if(method==='work.now')return {needsYou:[],running:[],progress:[],current:[],temporary:[],withdrawn:[],retired:[]};
        if(method==='settings.model.get')return {harness:'harness-stub'};
        return null;
      },
    }});
  },DEFAULT_PREFS);
  await page.goto(url);await expect(page.locator('[data-ready=true]')).toBeVisible();
  await expect(page.getByTestId('startup-data-folder')).toContainText('/data/Current work');
  await page.screenshot({path:join(dir,'00-first-run-folder.png')});
  if((page.viewportSize()?.width??1440)<768)await page.getByRole('button',{name:'Open sidebar',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Settings'});await settings.getByRole('button',{name:'Backup',exact:true}).click();
  const section=settings.getByTestId('backup');
  const shot=(name:string)=>page.screenshot({path:join(dir,`${name}.png`)});
  await expect(section.getByRole('button',{name:'Open another data folder…'})).toBeVisible();await shot('01-pick');
  await section.getByRole('button',{name:'View restore'}).click();
  const dialog=page.getByTestId('restore-dialog');await expect(dialog.getByRole('button',{name:'Open the restored folder'})).toBeVisible();await expect(dialog).toContainText('upgraded in place');await shot('02-restored');
  await dialog.getByRole('button',{name:'Open the restored folder'}).click();
  await expect(dialog.getByText('Starting another window.',{exact:false})).toBeVisible();await shot('03-starting');
  await expect(dialog.getByText('Opened in another window.',{exact:false})).toBeVisible();await shot('04-opened');
  await dialog.getByText('From a terminal',{exact:true}).click();await expect(dialog).toContainText('open -n -a');await shot('05-terminal');
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
  for(const state of ['already-open','current','expired','failed','unknown']){
    await page.evaluate(state=>{(window as any).folderFixture.state=state;},state);
    await section.getByRole('button',{name:'Open another data folder…'}).click();
    const button=section.getByRole('button',{name:'Open this data folder'});await button.focus();await expect(button).toBeFocused();await button.press('Enter');
    const result=section.getByText(state==='already-open'?'This data folder is already open':state==='current'?'This data folder is the folder this window already shows.':state==='failed'||state==='expired'?'Could not start.':'Opening could not be confirmed.',{exact:false});
    await expect(result).toBeVisible();await result.scrollIntoViewIfNeeded();await shot(`06-${state}`);
    await expect(button).toBeDisabled();
    if(state==='expired')await expect(result).toContainText('Open another data folder…');
  }
  expect(await page.evaluate(()=>(window as any).folderFixture.calls)).toBe(6);
  await page.evaluate(()=>{(window as any).folderFixture.badPick=true;});await section.getByRole('button',{name:'Open another data folder…'}).click();
  await expect(section.getByRole('alert')).toContainText('not a finished data folder');await section.getByRole('alert').scrollIntoViewIfNeeded();await shot('07-refused-folder');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(0);
});


for(const state of ['keys','system','keychain','paused','held'] as const){
  test(`a local ${state} startup names its folder and offers truthful recovery`,async({page},info)=>{
    await page.addInitScript(({prefs,state})=>{
      const detail=state==='system'?'This data folder’s keys are protected by the command’s system key store; this app uses a different Keychain format, so open it with the command that created it or restore an export into a new data folder.':'This data folder keeps its keys in plain files; the installed app requires Keychain-held keys, so open it with the command that created it or restore an export into a new data folder.';
      Object.assign(window,{backbone:{platform:'linux',setTheme(){},onEvent(){return()=>{};},
        appInfo:async()=>({packaged:true,version:'0',dataFolder:'/data/Command-created work'}),
        identityConfiguration:async()=>({company:false,signedIn:true}),
        identityRecoveryStatus:async()=>({available:false}),
        dataFolderStatus:async()=>state==='keys'||state==='system'?{kind:'keys',detail}:state==='keychain'?{kind:'keychain',detail:'The Keychain did not give this data folder’s keys. Unlock the Keychain, or allow access when macOS asks, then open the app again. Nothing was changed.'}:undefined,
        async call(method:string){
          if(method==='host.status')return {owns:state!=='held',...(state==='held'?{heldBy:{kind:'daemon',pid:1234}}:{})};
          if(state==='paused')throw Object.assign(new Error('paused'),{name:'IdentityUnavailable'});
          if(method==='identity.get')throw Object.assign(new Error('masked key error'),{name:'IdentityUnavailable'});
          if(method==='viewer.get')return prefs;
          return [];
        },
      }});
    },{prefs:DEFAULT_PREFS,state});
    await page.goto(url);
    await expect(page.getByTestId('startup-data-folder')).toContainText('/data/Command-created work');
    if(state==='keys'||state==='system'){
      await expect(page.getByRole('alert')).toContainText(state==='system'?'different Keychain format':'plain files');
      await expect(page.getByRole('alert')).toContainText('command that created it');
      await expect(page.getByText('Quit and open the app again to retry.')).toHaveCount(0);
      await expect(page.getByText('Settings › Backup',{exact:true})).toHaveCount(0);
    }
    if(state==='keychain'){
      // A refusing Keychain is a start to retry: the folder may be the person's own.
      await expect(page.getByRole('heading',{name:'The app could not start'})).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('Unlock the Keychain');
      await expect(page.getByText('Quit and open the app again to retry.')).toHaveCount(1);
      await expect(page.getByRole('alert')).not.toContainText('restore an export');
    }
    if(state==='held')await expect(page.getByTestId('home-held')).toContainText('command line’s keys');
    if(state!=='held')await expect(page.getByRole('heading',{name:'Workspace sign-in'})).toHaveCount(0);
    const dir=join(process.env.BACKBONE_OPEN_RESTORED_SHOTS??join(repoRoot,'evidence/open-restored'),info.project.name);mkdirSync(dir,{recursive:true});
    await page.screenshot({path:join(dir,`08-startup-${state}.png`)});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(0);
  });
}


test('a finished restore shows its separate open refusal without promising a launch',async({page},info)=>{
  await page.addInitScript(prefs=>{
    Object.assign(window,{backbone:{platform:'linux',setTheme(){},onEvent(){return()=>{};},
      appInfo:async()=>({packaged:false,version:'0',dataFolder:'/data/Current work'}),
      restoreBackup:async()=>({availability:{available:true},currentFolder:'/data/Current work',job:{state:'done',target:'/data/Restored work',from:'/backups/export',finishedAt:new Date().toISOString(),counts:{},adds:{},skipped:[],openProblem:'Restored, but this app cannot open it from here: this data folder is incomplete.'}}),
      async call(method:string,args:any){
        if(method==='host.status')return {owns:true};
        if(method==='settings.policy.get')return {state:'none'};
        if(method==='viewer.get')return {...prefs,pane:{open:false,tabs:[]}};
        if(method==='viewer.put')return args.prefs;
        if(method==='identity.get')return {ok:true,value:{person:{id:'owner',name:'Owner',role:'owner',status:'active'},people:[],deviceOwner:true}};
        if(['projects.list','threads.list','models.list','plugins.parts','material.list','files.list'].includes(method))return [];
        if(method==='work.now')return {needsYou:[],running:[],progress:[],current:[],temporary:[],withdrawn:[],retired:[]};
        if(method==='settings.model.get')return {harness:'harness-stub'};
        return null;
      },
    }});
  },DEFAULT_PREFS);
  await page.goto(url);await expect(page.locator('[data-ready=true]')).toBeVisible();
  if((page.viewportSize()?.width??1440)<768)await page.getByRole('button',{name:'Open sidebar',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Settings'});await settings.getByRole('button',{name:'Backup',exact:true}).click();
  await settings.getByRole('button',{name:'View restore'}).click();
  const done=page.getByTestId('restore-done');await expect(done).toBeVisible();
  await expect(done.getByRole('alert')).toContainText('Restored, but this app cannot open it');
  await expect(done.getByRole('button',{name:'Open the restored folder'})).toHaveCount(0);
  await expect(done).not.toContainText('while the restored folder opens');
  await expect(page.getByTestId('restore-unknown')).toHaveCount(0);
  const dir=join(process.env.BACKBONE_OPEN_RESTORED_SHOTS??join(repoRoot,'evidence/open-restored'),info.project.name);mkdirSync(dir,{recursive:true});
  await page.screenshot({path:join(dir,'09-restored-open-refused.png')});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(0);
});
