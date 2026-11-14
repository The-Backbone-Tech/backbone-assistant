// Real renderer, synthetic API only: a capability notice is never a document or a decision.
import {expect,test} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {DEFAULT_PREFS} from '@backbone-next/platform';
let server:ViteDevServer;let url:string;
test.beforeAll(async()=>{server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0}});await server.listen();url=server.resolvedUrls!.local[0];});
test.afterAll(async()=>{await server?.close();});
for(const notice of [
 'Knowledge promotion and recall are paused because source checks could not be verified. Other work remains available; your sources and decisions are kept.',
 'Only message and web evidence is eligible for agent recall and promotion while material withdrawal checks are being completed. Older knowledge with other or uncertain sources is withheld from agents. Your records remain available.',
])for(const format of ['legacy','structured'] as const)test(`Now displays ${format} source coverage without creating a held document: ${notice.slice(0,35)}`,async({page})=>{
 await page.addInitScript(({prefs,notice,format})=>{
  Object.assign(window,{backbone:{platform:'linux',setTheme(){},onEvent(){return()=>{};},async call(method:string,args:any){
   if(method==='identity.get')return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
   if(method==='host.status')return{owns:true};
   if(method==='viewer.get')return{...prefs,view:'now',selectedProjectId:'p'};
   if(method==='viewer.put')return args.prefs;
   if(method==='projects.list')return[{id:'p',name:'Synthetic project',kind:'folder',createdAt:'2026-11-09T09:00:00Z'}];
   if(['threads.list','models.list','files.list','material.list'].includes(method))return[];
   if(method==='work.now')return{notices:[format==='legacy'?notice:{code:'knowledge-source-guard',message:notice}],needsYou:[],running:[],progress:[],current:[],temporary:[],withdrawn:[],retired:[]};
   return null;
  }}});
 },{prefs:DEFAULT_PREFS,notice,format});
 await page.goto(url);
 await expect(page.getByTestId('knowledge-source-notice')).toHaveText(notice);
 await expect(page.getByTestId('knowledge-source-notice')).toHaveAttribute('role','status');
 if(format==='structured')await expect(page.getByTestId('knowledge-source-notice')).toHaveAttribute('data-notice-code','knowledge-source-guard');
 await expect(page.getByTestId('now-needs-you')).toHaveCount(0);
 await expect(page.getByText('Nothing is unfinished.')).toBeVisible();
 await expect(page.getByTestId('knowledge-source-notice').getByRole('button')).toHaveCount(0);
});
