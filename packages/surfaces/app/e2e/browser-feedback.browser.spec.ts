// The real renderer with synthetic identity/IPC responses; native admission is tested separately.
import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFS } from '@backbone-next/platform';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0}});
  await server.listen(); url=server.resolvedUrls!.local[0];
});
test.afterAll(async () => {await server?.close();});
async function open(page: Page, joined: boolean, scripted = false) {
  await page.addInitScript(({prefs,joined,scripted}) => {
    Object.assign(window,{paneRequests:[],paneState:{url:'',title:'Browser',phase:'empty',back:false,forward:false},backbone:{
      platform:'linux',setTheme(){},onEvent(){return ()=>{};},
      identityConfiguration:async()=>({company:!joined,signedIn:true,remote:joined?{origin:'https://workspace.test',connection:'online'}:undefined}),
      browserRequest:scripted?async(request:any)=>{
        const w=window as any;w.paneRequests.push(request);
        if(request.action==='layout')return w.paneState;
        if(request.action==='navigate'&&request.url.includes('gone')) w.paneState={url:request.url,title:'Browser',phase:'failed',back:false,forward:false,detail:'Could not load this page. Check the address and your connection, then try again. If you submitted a form, its result is not known; check before submitting again.',technical:'ERR_NAME_NOT_RESOLVED'};
        if(request.action==='navigate'&&request.url.includes('long')) w.paneState={url:request.url,title:'Long page',phase:'ready',back:false,forward:false};
        if(request.action==='external')return {...w.paneState,requestRefused:true,detail:'This address is longer than 8,192 characters, so it cannot be opened.'};
        return w.paneState;
      }:async()=>({url:'',title:'Browser',phase:'blocked',back:false,forward:false,detail:'Browser is not available in a company configuration. Company policy does not define personal browser access.'}),
      async call(method:string,args:any){
        if(method==='host.status')return {owns:true};
        if(method==='identity.get')return {ok:true,value:{person:{id:'person',name:'Colleague',role:'member',status:'active'},people:[],deviceOwner:false}};
        if(method==='viewer.get')return {...prefs,selectedProjectId:'project',pane:{open:true,tabs:[{id:'browser',kind:'browser'}],active:'browser'}};
        if(method==='viewer.put')return args.prefs;
        if(method==='projects.list')return [{id:'project',name:'Shared work',kind:'folder',createdAt:'2026-11-14T00:00:00Z'}];
        if(['threads.list','models.list','plugins.parts','material.list','files.list'].includes(method))return [];
        if(method==='work.now')return {needsYou:[],running:[],progress:[],current:[],temporary:[],withdrawn:[],retired:[]};
        if(method==='drafts.get')return null;
        if(method==='settings.model.get')return {harness:'harness-stub'};
        if(method==='settings.policy.get')return {state:'none'};
        return null;
      },
    }});
  },{prefs:DEFAULT_PREFS,joined,scripted});
  await page.goto(url); await expect(page.locator('[data-ready=true]')).toBeVisible();
}
test('a company Browser refusal gives its reason without claiming an unconfirmed outcome',async({page})=>{
  await open(page,false);
  await expect(page.getByTestId('browser-tab').getByRole('alert')).toContainText('Browser is not available in a company configuration.');
  await expect(page.getByText('Browser state is not known.')).toHaveCount(0);
});
test('a joined workspace explains why Browser is unavailable and has no browser pane',async({page})=>{
  await open(page,true);
  await expect(page.getByText('Browser is not available here; pages belong to the local device owner.')).toBeVisible();
  await expect(page.getByTestId('browser-tab')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+B');
  await expect(page.getByTestId('browser-tab')).toHaveCount(0);
});

async function shot(page:Page,name:string){
  const folder=process.env.BACKBONE_LOWS_SHOTS;if(!folder)return;
  mkdirSync(folder,{recursive:true});await page.mouse.move(1,1);
  await page.screenshot({animations:'disabled',path:join(folder,`${test.info().project.name.replace(/^browser-/,'')}-${name}.png`)});
}
const requests=(page:Page)=>page.evaluate(()=>(window as any).paneRequests.filter((r:any)=>r.action!=='layout'&&r.action!=='state') as {action:string}[]);
test('Enter on an empty address does nothing: no request, no refusal',async({page})=>{
  await open(page,false,true);
  const address=page.getByRole('textbox',{name:'Page address'});
  await address.fill('');await address.press('Enter');
  await address.fill('   ');await address.press('Enter');
  expect(await requests(page)).toEqual([]);
  await expect(page.getByText('Page blocked')).toHaveCount(0);
  await expect(page.getByText('Open a page beside your work')).toBeVisible();
  await shot(page,'browser-empty-enter');
});
test('a page that fails to load gives a plain sentence and keeps the error code behind Details',async({page})=>{
  await open(page,false,true);
  const address=page.getByRole('textbox',{name:'Page address'});
  await address.fill('https://gone.example.test/');await address.press('Enter');
  const tab=page.getByTestId('browser-tab');
  await expect(tab.getByRole('alert')).toContainText('Could not load this page.');
  await expect(tab.getByRole('alert')).not.toContainText('ERR_');
  await expect(tab.getByTestId('browser-failure-code')).toBeHidden();
  await shot(page,'browser-failed-plain');
  await tab.getByText('Details',{exact:true}).click();
  await expect(tab.getByTestId('browser-failure-code')).toHaveText('ERR_NAME_NOT_RESOLVED');
  await shot(page,'browser-failed-details');
});
test('Open in my browser on an address that is too long says the address is too long',async({page})=>{
  await open(page,false,true);
  const address=page.getByRole('textbox',{name:'Page address'});
  await address.fill('https://long.example.test/');await address.press('Enter');
  await page.getByRole('button',{name:'Open in my browser'}).click();
  await expect(page.getByTestId('browser-tab').getByRole('status')).toContainText('longer than 8,192 characters');
  await expect(page.getByTestId('browser-tab').getByRole('status')).not.toContainText('credentials');
  await shot(page,'browser-address-too-long');
});
