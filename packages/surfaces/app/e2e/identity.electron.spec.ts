import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeDataHome } from '@backbone-next/platform/composition';
import { api, appDir, openSidebar } from './journey';
import type { Project, Receipt, Thread } from '@backbone-next/platform';

test('an admin invites a second person, shares one project as viewer and removes their live access', async () => {
  const home=mkdtempSync(join(tmpdir(),'identity-installed-')),person=mkdtempSync(join(tmpdir(),'identity-person-'));
  let app:ElectronApplication|undefined;
  try {
    const installed=process.env.BACKBONE_APP_EXECUTABLE;
    app=await _electron.launch({...installed?{executablePath:installed,args:[]}:{args:[appDir]},env:{...process.env,BACKBONE_HOME:home,BACKBONE_USER_HOME:person,BACKBONE_HARNESS:'harness-stub',BACKBONE_IDENTITY_ISSUER:'',BACKBONE_IDENTITY_CLIENT_SECRET:''}});
    expect(await app.evaluate(({app})=>app.isPackaged)).toBe(!!installed);
    const owner=await app.firstWindow();
    await expect(owner.locator('[data-ready=true]')).toBeVisible({timeout:60_000});
    const shared=await api<Receipt<Project>>(owner,'projects.create',{name:'Shared evidence',kind:'folder',clientKey:randomUUID()});
    const privateProject=await api<Receipt<Project>>(owner,'projects.create',{name:'Private evidence',kind:'folder',clientKey:randomUUID()});
    expect(shared.ok&&privateProject.ok).toBe(true);
    if(!shared.ok||!privateProject.ok)throw new Error('Fixture project creation refused');
    await api(owner,'turns.send',{projectId:shared.value.id,text:'Write a brief',attachments:[],settings:{permission:'full',model:'stub',effort:3,runsOn:'this-computer',mode:'chat'},clientKey:randomUUID()});
    await openSidebar(owner);
    await owner.getByRole('button',{name:'Settings',exact:true}).click();
    const settings=owner.getByRole('dialog',{name:'Settings'});
    await settings.getByRole('button',{name:'People and roles',exact:true}).click();
    await settings.getByLabel('Invitation role').selectOption('guest');
    await settings.getByRole('button',{name:'Create invitation',exact:true}).click();
    const invitation=await settings.getByLabel('Invitation code', {exact:true}).inputValue();
    expect(invitation.length).toBeGreaterThan(30);
    const secondWindow=app.waitForEvent('window');
    await settings.getByRole('button',{name:'Open sign-in window',exact:true}).click();
    const viewer=await secondWindow;
    await viewer.getByLabel('Your name',{exact:true}).fill('Project viewer');
    await viewer.getByLabel('Invitation code',{exact:true}).fill(invitation);
    await viewer.getByRole('button',{name:'Join workspace',exact:true}).click();
    await expect(viewer.locator('[data-ready=true]')).toBeVisible();
    expect(await api<Project[]>(viewer,'projects.list',{})).toEqual([]);
    const joinRefusal=await viewer.evaluate(async()=>{try{await window.backbone!.joinRemoteWorkspace!('unused-link','Member');return '';}catch(error){return String(error);}});
    expect(joinRefusal).toContain('Only the device owner can join a workspace on this Mac.');
    expect(await viewer.evaluate(async()=>{try{await window.backbone!.openRemoteWorkspace!();return false;}catch(error){return String(error).includes('Only the device owner');}})).toBe(true);
    expect(app.windows()).toHaveLength(2);
    await settings.getByRole('button',{name:'Sharing',exact:true}).click();
    await settings.getByLabel('Shared project',{exact:true}).selectOption(shared.value.id);
    await settings.getByLabel('Share with',{exact:true}).selectOption({label:'Project viewer'});
    await settings.getByLabel('Project permission',{exact:true}).selectOption('viewer');
    await settings.getByRole('button',{name:'Save sharing',exact:true}).click();
    await expect.poll(async()=> (await api<Project[]>(viewer,'projects.list',{})).map(project=>project.id)).toEqual([shared.value.id]);
    await openSidebar(viewer);
    await viewer.getByRole('button',{name:/^Shared evidence(?:\s+\d+)?$/}).click();
    await expect(viewer.getByText('Viewer access: this project is read only.',{exact:true}).first()).toBeVisible();
    const refused=await viewer.evaluate(async(id)=>{try{await window.backbone!.call('turns.send',{projectId:id,text:'Change it',attachments:[],settings:{permission:'full',model:'stub',effort:3,runsOn:'this-computer',mode:'chat'},clientKey:crypto.randomUUID()});return false;}catch{return true;}},shared.value.id);
    expect(refused).toBe(true);
    expect(await viewer.evaluate(async(id)=>{try{await window.backbone!.call('files.list',{projectId:id});return false;}catch{return true;}},privateProject.value.id)).toBe(true);
    await settings.getByRole('button',{name:'People and roles',exact:true}).click();
    await settings.getByRole('button',{name:'Remove Project viewer',exact:true}).click();
    await owner.getByRole('dialog',{name:'Remove Project viewer?'}).getByRole('button',{name:'Remove Project viewer',exact:true}).click();
    await expect(viewer.getByRole('heading',{name:'Workspace sign-in',exact:true})).toBeVisible();
    expect(await viewer.evaluate(async()=>{try{await window.backbone!.call('projects.list',{});return false;}catch{return true;}})).toBe(true);
  } finally {
    if(app){
      // Revocation may leave a surface preserving an unconfirmed draft. Bound fixture
      // shutdown without hiding the original failure or borrowing another home's lock.
      const child=app.process();
      let timer:ReturnType<typeof setTimeout>|undefined;
      try { await Promise.race([app.close(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('The identity fixture could not close its app.')),10_000);})]); }
      finally { if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;} }
    }
    await removeDataHome(home);rmSync(home,{recursive:true,force:true});rmSync(person,{recursive:true,force:true});
  }
});
