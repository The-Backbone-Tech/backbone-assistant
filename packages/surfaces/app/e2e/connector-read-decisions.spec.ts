// Renderer/person boundary with controlled transport. No Core, provider or native claim.
import {expect,test,type Page} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {DEFAULT_PREFS} from '@backbone-next/platform';
const FIRST='a'.repeat(56)+'11111111',SECOND='b'.repeat(56)+'22222222',UNKNOWN='c'.repeat(56)+'33333333';
let server:ViteDevServer,url:string;
test.beforeAll(async()=>{
 server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0}});
 await server.listen();url=server.resolvedUrls!.local[0];
});
test.afterAll(async()=>{await server?.close();});
async function open(page:Page,mode:'success'|'unknown'|'wait'='success'){
 await page.addInitScript(({prefs,mode,ids})=>{
  const at='2026-11-09T00:00:00Z',detail='A response is retained. Choose how to resolve it.';
  const fixture={mode,calls:[] as {id:string;verdict:string}[],release:undefined as undefined|(()=>void),cards:[
   // Identical thread/detail deliberately exercises the React-key collision, independently
   // of the real projection's additional display metadata. Only exact observation IDs differ.
   ...ids.slice(0,2).map(id=>({kind:'connector-read',observationId:id,threadId:'same-thread',
    title:`Connector read · Server · lookup · 2026-11-09 00:00:00.000 UTC · …${id.slice(-8)}`,detail,canReconcile:true})),
   {kind:'connector-read',observationId:ids[2],threadId:'same-thread',title:`Connector read · Server · lookup · 2026-11-09 00:00:00.000 UTC · …${ids[2].slice(-8)}`,
    detail:'No verified response is retained. It will not be sent again.',canReconcile:false},
  ]};
  Object.assign(window,{fixture,backbone:{platform:'linux',setTheme(){},onEvent(){return()=>{};},
   async call(method:string,args:any){
    if(method==='identity.get')return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
    if(method==='host.status')return {owns:true};
    if(method==='viewer.get')return {...prefs,view:'now',selectedProjectId:'p'};
    if(method==='viewer.put')return args.prefs;
    if(method==='projects.list')return [{id:'p',name:'Read decisions',kind:'folder',createdAt:at}];
    if(['threads.list','models.list','files.list','material.list'].includes(method))return [];
    if(method==='work.now')return {needsYou:structuredClone(fixture.cards),running:[],progress:[],current:[],temporary:[],withdrawn:[],retired:[],
     notices:[{code:'material-withdrawal-pending',materialId:'source',message:'Withdrawal confirmation is pending for source.md.'}]};
    if(method==='connectors.resolveRead'){
     fixture.calls.push(structuredClone(args));
     if(fixture.mode==='wait')await new Promise<void>(resolve=>{fixture.release=resolve;});
     if(fixture.mode==='unknown')return {ok:false,reason:'UNKNOWN_OUTCOME_HELD',outcome:'UNKNOWN',detail:'The exact observation remains pending. No provider was called.'};
     fixture.cards=fixture.cards.filter(card=>card.observationId!==args.id);
     return {ok:true,value:{id:args.id,state:args.verdict==='discard'?'discarded':'reconciled',registration:args.verdict==='discard'?'unknown':'confirmed',runClosed:false}};
    }
    return null;
   }
  }});
 },{prefs:DEFAULT_PREFS,mode,ids:[FIRST,SECOND,UNKNOWN]});
 await page.goto(url);await expect(page.getByTestId('now-needs-you')).toHaveCount(3);
}
const card=(page:Page,id:string)=>page.locator(`[data-testid="now-needs-you"][data-observation-id="${id}"]`);
test('loading never resolves history; person reconciliation names only the selected exact observation',async({page})=>{
 await open(page);expect(await page.evaluate(()=>(window as any).fixture.calls)).toEqual([]);
 const observed=card(page,FIRST);
 await observed.getByRole('button',{name:'Reconcile',exact:true}).click();await expect(observed).toHaveCount(0);
 await expect(card(page,SECOND)).toHaveCount(1);await expect(card(page,UNKNOWN)).toHaveCount(1);
 expect(await page.evaluate(()=>(window as any).fixture.calls)).toEqual([{id:FIRST,verdict:'reconcile'}]);
 await expect(page.locator('[data-notice-code="material-withdrawal-pending"]')).toHaveText('Withdrawal confirmation is pending for source.md.');
});
test('without a retained result reconcile is disabled; an uncertain discard stays visible without an automatic retry',async({page})=>{
 await open(page,'unknown');const unknown=card(page,UNKNOWN);
 await expect(unknown.getByRole('button',{name:'Reconcile',exact:true})).toBeDisabled();
 await unknown.getByRole('button',{name:'Discard from agent use',exact:true}).click();
 await expect(page.getByTestId('now-problem')).toContainText('The exact observation remains pending.');await expect(unknown).toHaveCount(1);
 expect(await page.evaluate(()=>(window as any).fixture.calls)).toEqual([{id:UNKNOWN,verdict:'discard'}]);
});
test('one pending person choice disables duplicate actions and waits for the checked state before removing the card',async({page})=>{
 await open(page,'wait');const observed=card(page,FIRST);
 await observed.getByRole('button',{name:'Discard from agent use',exact:true}).click();
 await expect(observed.getByRole('button',{name:'Reconcile',exact:true})).toBeDisabled();await expect(observed).toHaveCount(1);
 expect(await page.evaluate(()=>(window as any).fixture.calls)).toEqual([{id:FIRST,verdict:'discard'}]);
 await page.evaluate(()=>(window as any).fixture.release());await expect(observed).toHaveCount(0);
 await expect(card(page,SECOND)).toHaveCount(1);await expect(card(page,UNKNOWN)).toHaveCount(1);
});
test('same-thread same-detail observations remain distinct cards and selecting the second never resolves the first',async({page})=>{
 const duplicateKeys:string[]=[];
 page.on('console',message=>{if(message.text().includes('Encountered two children with the same key'))duplicateKeys.push(message.text());});
 await open(page);expect(duplicateKeys).toEqual([]);
 const same=await page.evaluate(()=>(window as any).fixture.cards.slice(0,2).map((item:any)=>({thread:item.threadId,detail:item.detail})));
 expect(same[0]).toEqual(same[1]);
 for(const id of [FIRST,SECOND,UNKNOWN]){
  await expect(card(page,id)).toContainText('lookup');await expect(card(page,id)).toContainText('2026-11-09 00:00:00.000 UTC');
  await expect(card(page,id)).toContainText(`…${id.slice(-8)}`);
 }
 await card(page,SECOND).getByRole('button',{name:'Discard from agent use',exact:true}).click();
 await expect(card(page,SECOND)).toHaveCount(0);await expect(card(page,FIRST)).toHaveCount(1);await expect(card(page,UNKNOWN)).toHaveCount(1);
 expect(await page.evaluate(()=>(window as any).fixture.calls)).toEqual([{id:SECOND,verdict:'discard'}]);
 await card(page,FIRST).getByRole('button',{name:'Reconcile',exact:true}).click();await expect(card(page,FIRST)).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).fixture.calls)).toEqual([{id:SECOND,verdict:'discard'},{id:FIRST,verdict:'reconcile'}]);
 expect(duplicateKeys).toEqual([]);
});
