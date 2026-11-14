import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Project, Receipt, Thread } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { api, appDir } from './journey';

async function settings(page:Page,section:string){await page.getByRole('button',{name:'Settings',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Settings'});await dialog.getByRole('button',{name:section,exact:true}).click();return dialog;}
async function close(app:ElectronApplication){const child=app.process();let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([app.close(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Test app close timed out')),10_000);})]);}finally{if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const ended=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await ended;}}}
async function port(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const chosen=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return chosen;}

// Lose only the reply, after the server has answered. Reads can temporarily hide
// submission keys to model the period before reconciliation evidence is visible.
async function transport(app:ElectronApplication,hide:boolean,lose=false){
  await app.evaluate((_electron,{hide,lose})=>{
    const state=globalThis as typeof globalThis&{sharedTransport?:{hide:boolean;lose:boolean;sends:number}};
    if(state.sharedTransport){state.sharedTransport.hide=hide;state.sharedTransport.lose=lose;return;}
    const control=state.sharedTransport={hide,lose,sends:0};
    const https=process.getBuiltinModule('node:https'),stream=process.getBuiltinModule('node:stream');
    const original=https.request;
    https.request=((url:any,options:any,callback:any)=>{
      let method='';
      const request=original(url,options,(response:any)=>{
        if(method==='turns.send'&&control.lose){control.lose=false;response.destroy();request.emit('error',new Error('Scripted lost reply'));return;}
        if(method==='threads.get'&&control.hide){
          const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.on('end',()=>{
            const value=JSON.parse(Buffer.concat(chunks).toString());if(value.ok)for(const turn of value.value.turns)delete turn.clientKey;
            const replacement=new stream.PassThrough() as any;replacement.statusCode=response.statusCode;callback(replacement);replacement.end(JSON.stringify(value));
          });return;
        }
        callback(response);
      });
      const end=request.end.bind(request);
      request.end=((body:any,...args:any[])=>{try{method=JSON.parse(String(body)).method;if(method==='turns.send')control.sends++;}catch{}return end(body,...args);}) as any;
      return request;
    }) as typeof https.request;
  },{hide,lose});
}
async function sendCount(app:ElectronApplication){return app.evaluate(()=> (globalThis as any).sharedTransport.sends as number);}

test('two apps share a project, join, read and send, restore the session, then enforce viewer access and removal',async()=>{
  const homes=[mkdtempSync(join(tmpdir(),'shared-app-owner-')),mkdtempSync(join(tmpdir(),'shared-app-colleague-'))];
  const users=homes.map(()=>mkdtempSync(join(tmpdir(),'shared-app-user-')));const apps:ElectronApplication[]=[];
  const launch=async(index:number)=>{
    const installed=process.env.BACKBONE_APP_EXECUTABLE;
    const app=await _electron.launch({...installed?{executablePath:installed,args:[]}:{args:[appDir]},env:{...process.env,BACKBONE_HOME:homes[index],BACKBONE_USER_HOME:users[index],BACKBONE_HARNESS:'harness-stub',BACKBONE_IDENTITY_ISSUER:'',BACKBONE_IDENTITY_CLIENT_SECRET:''}});apps.push(app);if(index===1)await transport(app,true);return app;
  };
  try {
    const ownerApp=await launch(0),owner=await ownerApp.firstWindow();await expect(owner.locator('[data-ready=true]')).toBeVisible({timeout:60_000});
    const shared=await api<Receipt<Project>>(owner,'projects.create',{name:'Shared project',kind:'folder',clientKey:randomUUID()});
    const privateProject=await api<Receipt<Project>>(owner,'projects.create',{name:'Owner private project',kind:'folder',clientKey:randomUUID()});
    expect(shared.ok&&privateProject.ok).toBe(true);if(!shared.ok||!privateProject.ok)throw new Error('Project fixture refused');
    const seed=await api<Receipt<{threadId:string}>>(owner,'turns.send',{projectId:shared.value.id,text:'Write a brief',attachments:[],settings:{permission:'full',model:'stub',effort:3,runsOn:'this-computer',mode:'chat'},clientKey:randomUUID()});expect(seed.ok).toBe(true);if(!seed.ok)throw new Error('Seed turn refused');
    await expect.poll(async()=>{const r=await api<Receipt<Thread>>(owner,'threads.get',{id:seed.value.threadId});return r.ok&&!r.value.summary.running;}).toBe(true);
    expect(await owner.evaluate(async()=>{try{return typeof (await window.backbone!.sharingView!()).enabled;}catch(error){return String(error);}})).toBe('boolean');
    const people=await settings(owner,'People and roles');
    await people.getByLabel('Computer address',{exact:true}).selectOption('127.0.0.1');await people.getByLabel('Port',{exact:true}).fill(String(await port()));
    await people.getByLabel('Let people on other computers connect',{exact:true}).check();
    await expect(people.getByText(/Certificate SHA-256:/)).toBeVisible();await expect(people.getByRole('status').filter({hasText:/Sharing is on at https:\/\/127\.0\.0\.1:/})).toBeVisible();
    await people.getByRole('button',{name:'Create invitation',exact:true}).click();const link=await people.getByLabel('Join link',{exact:true}).inputValue();expect(link.startsWith('https://127.0.0.1:')).toBe(true);
    let colleagueApp=await launch(1);const local=await colleagueApp.firstWindow();await expect(local.locator('[data-ready=true]')).toBeVisible({timeout:60_000});
    const personal=await api<Receipt<Project>>(local,'projects.create',{name:'Colleague local project',kind:'folder',clientKey:randomUUID()});expect(personal.ok).toBe(true);
    const next=colleagueApp.waitForEvent('window');await colleagueApp.evaluate(({Menu})=>{const item=Menu.getApplicationMenu()!.items.flatMap(item=>item.submenu?.items??[]).find(item=>item.label==='Join a workspace…');if(!item)throw new Error('Join menu missing');item.click();});const colleague=await next;
    await colleague.getByRole('button',{name:'Join a workspace…',exact:true}).click();await colleague.getByLabel('Your name',{exact:true}).fill('Remote colleague');await colleague.getByLabel('Join link',{exact:true}).fill(link);await colleague.getByRole('button',{name:'Join workspace',exact:true}).click();
    await expect(colleague.locator('[data-ready=true]')).toBeVisible();await expect(colleague.getByText(/Workspace at.*Runs on the owner’s computer/)).toBeVisible();
    expect(await api<Project[]>(colleague,'projects.list',{})).toEqual([]);
    await people.getByRole('button',{name:'Sharing',exact:true}).click();await people.getByLabel('Shared project',{exact:true}).selectOption(shared.value.id);await people.getByLabel('Share with',{exact:true}).selectOption({label:'Remote colleague'});await people.getByLabel('Project permission',{exact:true}).selectOption('editor');await people.getByRole('button',{name:'Save sharing',exact:true}).click();
    await expect.poll(async()=>(await api<Project[]>(colleague,'projects.list',{})).map(project=>project.id)).toEqual([shared.value.id]);
    const original=await api<Receipt<Thread>>(colleague,'threads.get',{id:seed.value.threadId});expect(original.ok&&original.value.turns[0].user.text).toBe('Write a brief');
    if(!original.ok)throw new Error('Shared conversation missing');
    await colleague.getByRole('button',{name:original.value.summary.title}).first().click();await expect(colleague.getByRole('textbox',{name:'Message',exact:true})).toBeDisabled();
    await colleague.getByRole('button',{name:/^Shared project(?:\s+\d+)?$/}).click();await colleague.getByRole('textbox',{name:'Message',exact:true}).fill('Write a colleague brief');await colleague.getByRole('button',{name:'Send',exact:true}).click();
    await expect(colleague.getByTestId('answer').first()).toContainText('I drafted brief.md');
    await expect(colleague.getByRole('button',{name:'Settings',exact:true})).toHaveCount(0);await expect(colleague.getByRole('button',{name:'Show side pane',exact:true})).toHaveCount(0);await expect.poll(async()=>{const threads=await api<{id:string;running:boolean}[]>(colleague,'threads.list',{});return threads.length===2&&threads.every(thread=>!thread.running);}).toBe(true);
    await people.getByRole('button',{name:'People and roles',exact:true}).click();await people.getByLabel('Let people on other computers connect',{exact:true}).uncheck();
    await expect(colleague.getByText(/Workspace at.*Temporary connection problem/)).toBeVisible();await expect(colleague.getByRole('heading',{name:'Workspace sign-in',exact:true})).toHaveCount(0);
    await people.getByLabel('Let people on other computers connect',{exact:true}).check();await expect(people.getByText(/Certificate SHA-256:/)).toBeVisible();
    await expect.poll(async()=>(await colleague.evaluate(()=>window.backbone!.identityConfiguration!())).remote?.connection).toBe('online');
    await people.getByRole('button',{name:'Sharing',exact:true}).click();await people.getByLabel('Shared project',{exact:true}).selectOption(shared.value.id);await people.getByLabel('Share with',{exact:true}).selectOption({label:'Remote colleague'});
    await close(colleagueApp);apps.splice(apps.indexOf(colleagueApp),1);colleagueApp=await launch(1);
    await expect.poll(()=>colleagueApp.windows().length).toBe(2);let restored:Page|undefined;for(const page of colleagueApp.windows()){await page.waitForLoadState();if((await page.evaluate(()=>window.backbone!.identityConfiguration!())).remote)restored=page;}if(!restored)throw new Error('Joined workspace not restored');await expect(restored.locator('[data-ready=true]')).toBeVisible();
    await restored.getByRole('button',{name:/^Shared project(?:\s+\d+)?$/}).click();
    // Reply loss never retries. The explicit inspection path clears the composer.
    const ownThreads=await api<{id:string;title:string}[]>(restored,'threads.list',{});
    const own=ownThreads.find(thread=>thread.id!==seed.value.threadId)!;
    await restored.getByRole('button',{name:own.title}).first().click();
    await transport(colleagueApp,true,true);
    await restored.getByRole('textbox',{name:'Message',exact:true}).fill('Lost reply, inspected by the person');await restored.getByRole('button',{name:'Send',exact:true}).click();
    await expect(restored.getByRole('button',{name:'I checked the conversation',exact:true})).toBeVisible();
    await expect(restored.getByRole('textbox',{name:'Message',exact:true})).toBeDisabled();expect(await sendCount(colleagueApp)).toBe(1);
    await people.getByRole('button',{name:'People and roles',exact:true}).click();await people.getByLabel('Let people on other computers connect',{exact:true}).uncheck();
    await expect(restored.getByText(/Workspace at.*Temporary connection problem/)).toBeVisible();
    await people.getByLabel('Let people on other computers connect',{exact:true}).check();await expect.poll(async()=>(await restored!.evaluate(()=>window.backbone!.identityConfiguration!())).remote?.connection).toBe('online');
    expect(await sendCount(colleagueApp)).toBe(1);
    await restored.getByRole('button',{name:'I checked the conversation',exact:true}).click();await expect(restored.getByRole('textbox',{name:'Message',exact:true})).toBeEnabled();expect(await sendCount(colleagueApp)).toBe(1);
    await expect.poll(async()=>{const r=await api<Receipt<Thread>>(restored!,'threads.get',{id:own.id});return r.ok&&!r.value.summary.running;}).toBe(true);
    // A second lost reply survives restart, then releases through its matching turn.
    await transport(colleagueApp,true,true);await restored.getByRole('textbox',{name:'Message',exact:true}).fill('Lost reply, reconciled from the turn');await restored.getByRole('button',{name:'Send',exact:true}).click();
    await expect(restored.getByRole('button',{name:'I checked the conversation',exact:true})).toBeVisible();expect(await sendCount(colleagueApp)).toBe(2);
    await close(colleagueApp);apps.splice(apps.indexOf(colleagueApp),1);colleagueApp=await launch(1);
    await expect.poll(()=>colleagueApp.windows().length).toBe(2);
    for(const page of colleagueApp.windows()){await page.waitForLoadState();if((await page.evaluate(()=>window.backbone!.identityConfiguration!())).remote)restored=page;}
    await expect(restored.locator('[data-ready=true]')).toBeVisible();await restored.getByRole('button',{name:own.title}).first().click();
    await expect(restored.getByRole('button',{name:'I checked the conversation',exact:true})).toBeVisible();expect(await sendCount(colleagueApp)).toBe(0);
    await transport(colleagueApp,false);await expect(restored.getByRole('textbox',{name:'Message',exact:true})).toBeEnabled({timeout:15_000});expect(await sendCount(colleagueApp)).toBe(0);
    await expect.poll(async()=>{const r=await api<Receipt<Thread>>(restored!,'threads.get',{id:own.id});return r.ok&&r.value.turns.length;}).toBe(3);
    await people.getByRole('button',{name:'Sharing',exact:true}).click();await people.getByLabel('Shared project',{exact:true}).selectOption(shared.value.id);await people.getByLabel('Share with',{exact:true}).selectOption({label:'Remote colleague'});
    await people.getByLabel('Project permission',{exact:true}).selectOption('viewer');await people.getByRole('button',{name:'Save sharing',exact:true}).click();
    await expect(restored.getByText('Viewer access: this project is read only.',{exact:true})).toBeVisible();await expect(restored.getByRole('textbox',{name:'Message',exact:true})).toBeDisabled();
    await people.getByRole('button',{name:'People and roles',exact:true}).click();await people.getByRole('button',{name:'Remove Remote colleague',exact:true}).click();
    await expect(restored.getByText('Your workspace access ended. Sign in again.',{exact:true})).toBeVisible();await expect(restored.getByRole('button',{name:'Join a workspace…',exact:true})).toBeVisible();
    const localRestored=colleagueApp.windows().find(page=>page!==restored)!;expect((await api<Project[]>(localRestored,'projects.list',{})).map(project=>project.name)).toEqual(['Colleague local project']);
    await people.getByLabel('Let people on other computers connect',{exact:true}).uncheck();await expect(people.getByText(/Certificate SHA-256:/)).toHaveCount(0);
  } finally {for(const app of apps.reverse())await close(app);for(const home of homes){await removeDataHome(home);rmSync(home,{recursive:true,force:true});}for(const user of users)rmSync(user,{recursive:true,force:true});}
});
