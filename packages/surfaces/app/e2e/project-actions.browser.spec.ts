import {expect,test,type Page} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
test.use({actionTimeout:30_000});
let server:ViteDevServer,url:string;
test.beforeAll(async()=>{server=await createServer({root:process.env.BACKBONE_PROJECT_ACTION_RENDERER_ROOT??fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0}});await server.listen();url=server.resolvedUrls!.local[0];});
test.afterAll(async()=>{await server?.close();});
test.beforeEach(async({page},info)=>{
  await page.addInitScript(({dark})=>{
    const at=new Date().toISOString();
    const projects:any[]=[{id:'p',name:'Launch plan',kind:'folder',createdAt:at,canUpdate:true},{id:'q',name:'Next project',kind:'folder',createdAt:at,canUpdate:true}];
    const threads=[{id:'t',projectId:'p',title:'Project conversation',archived:false,pinned:true,unread:false,running:false,updatedAt:at}];
    let prefs:any={theme:dark?'dark':'light',selectedProjectId:'p',pane:{open:false,tabs:[]}};
    const listeners:((e:any)=>void)[]=[];
    const f={projects,threads,emit:(event:any={topic:'projects'})=>listeners.forEach(listener=>listener(event)),schedules:[] as any[],runs:[] as any[],calls:[] as any[],mode:'ok',remote:(window as any).startRemote===true};
    Object.assign(window,{fixture:f,backbone:{identityConfiguration:async()=>({remote:(f.remote||(window as any).startRemote===true)?{origin:'https://workspace.example.test',connection:'online'}:undefined}),platform:'linux',setTheme(){},onEvent(listener:any){listeners.push(listener);return()=>{};},async call(method:string,args:any){
      switch(method){
        case 'identity.get':return {ok:true,value:{person:{id:'person',name:'Test owner',role:'owner',status:'active'},people:[],deviceOwner:true}};
        case 'host.status':return {owns:true};
        case 'projects.list':return structuredClone(projects);
        case 'threads.list':return threads;
        case 'threads.search':return threads.filter(t=>t.title.toLowerCase().includes(args.query.toLowerCase())).map(t=>({threadId:t.id,title:t.title,field:'title',snippet:t.title}));
        case 'threads.update':Object.assign(threads.find(t=>t.id===args.id)!,args.patch);listeners.forEach(listener=>listener({topic:'threads'}));return {ok:true,value:threads[0]};
        case 'threads.get':return {ok:true,value:{summary:threads[0],turns:[],sideTurns:[],card:{title:threads[0].title,project:projects[0].name,changes:{added:0,removed:0,files:0},sources:[],subagents:{active:0,done:0}},queue:[]}};
        case 'viewer.get':if((window as any).startArchived){projects[0].archived=true;if((window as any).startOpenChat)prefs.selectedThreadId='t';}return prefs;
        case 'viewer.put':prefs=args.prefs;return prefs;
        case 'models.list':return [{id:'stub',label:'Stub',efforts:[1,2,3,4,5]}];
        case 'settings.engines.get':return {active:'stub',engines:[]};
        case 'settings.model.get':return {};
        case 'identity.sharing':return {ok:true,value:{access:'owner',people:[{id:'ana',name:'Ana',status:'active'}],grants:f.schedules.length?[{person:'ana',access:'editor'}]:[]}};
        case 'schedules.get':return {schedules:f.schedules,runs:f.runs,heartbeat:null,brief:{time:'08:00',latest:null},interruptions:{date:'',briefs:0,emergencies:[]}};
        case 'drafts.get':return {text:'',revision:0};
        case 'drafts.put':return {ok:true,value:{revision:1}};
        case 'work.now':return {needsYou:[],running:[],progress:[],current:[],temporary:[],retired:[],withdrawn:[]};
        case 'projects.update':{
          f.calls.push(args);
          if(f.mode==='refused')return {ok:false,outcome:'REFUSED',reason:'NOT_AVAILABLE',detail:'Only the project owner may rename, archive or restore this project.'};
          if(f.mode==='thrown-refused'){const error=new Error('Project access refused');error.name='IdentityRefused';throw error;}
          if(f.mode==='unknown')throw new Error('controlled lost response');
          const project=projects.find(p=>p.id===args.id);Object.assign(project,args.patch);
          if(f.mode==='unknown-committed')throw new Error('controlled reply and event loss after commit');
          listeners.forEach(listener=>listener({topic:'projects',id:project.id}));return {ok:true,value:project};
        }
        default:return [];
      }
    }}});
  },{dark:info.project.use.colorScheme==='dark'});
  await page.goto(url);
  if(page.viewportSize()!.width<768)await page.getByRole('button',{name:'Open sidebar',exact:true}).click();
  await expect(page.getByRole('button',{name:'Project actions for Launch plan',exact:true})).toBeVisible();
});
const main=(page:Page,name='Launch plan')=>page.getByRole('navigation',{name:'Projects and threads'}).getByRole('button',{name,exact:true});
async function rename(page:Page,name:string){const field=page.getByRole('textbox',{name:'Project name',exact:true});await expect(field).toBeFocused();await field.fill(name);await field.press('Enter');await expect(main(page,name)).toBeVisible();}

test('project menu and right-click share actions; rename, keyboard focus, archive and restore',async({page},info)=>{
  await page.getByRole('button',{name:'Project actions for Launch plan',exact:true}).click();
  await expect(page.getByRole('menu')).toBeVisible();
  const items=(await page.getByRole('menuitem').allTextContents()).map(text=>text.trim());expect(items).toEqual(['Rename','Archive']);
  await page.getByRole('menuitem',{name:'Rename',exact:true}).click();await rename(page,'Launch renamed');
  await main(page,'Launch renamed').click({button:'right'});
  expect((await page.getByRole('menuitem').allTextContents()).map(text=>text.trim())).toEqual(items);
  await page.getByRole('menuitem',{name:'Rename',exact:true}).click();await rename(page,'Final project');
  const target=main(page,'Final project');await target.focus();await target.press('Shift+F10');await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');await expect(target).toBeFocused();
  await target.press('Shift+F10');
  const dir=process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS;
  if(dir){mkdirSync(dir,{recursive:true});await page.screenshot({path:join(dir,`${info.project.name}-menu.png`)});}
  await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
  await expect(target).toHaveCount(0);await expect(main(page,'Next project')).toBeFocused();
  await expect(page.getByRole('button',{name:'Project conversation',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'More',exact:true}).click();
  await page.getByRole('menuitem',{name:/^Archived/}).hover();
  await expect(page.getByRole('menuitem',{name:'Final project',exact:true})).toBeVisible();
  const archivePanel=page.getByRole('menu').filter({has:page.getByRole('menuitem',{name:'Final project',exact:true})});
  const bounds=await archivePanel.boundingBox();expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  if(dir)await page.screenshot({path:join(dir,`${info.project.name}-archived.png`)});
  await page.getByRole('menuitem',{name:'Final project',exact:true}).click();
  await expect(main(page,'Final project')).toBeVisible();
  await expect(page.getByRole('button',{name:'Project conversation',exact:true})).toBeVisible();
  if(dir)await page.screenshot({path:join(dir,`${info.project.name}-restored.png`)});
});

test('refusal keeps the typed name and explains the owner rule',async({page},info)=>{
  await page.evaluate(()=>{(window as any).fixture.mode='refused';});
  await main(page).click({button:'right'});await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
  const field=page.getByRole('textbox',{name:'Project name'});await expect(field).toBeFocused();await field.fill('Keep my name');await field.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Only the project owner');await expect(field).toHaveValue('Keep my name');
  if(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS)await page.screenshot({path:join(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS,`${info.project.name}-refused.png`)});
  await page.evaluate(()=>{(window as any).fixture.mode='ok';});await field.press('Enter');await expect(main(page,'Keep my name')).toBeVisible();
});

test('unknown change is checked without replaying it',async({page})=>{
  await page.evaluate(()=>{(window as any).fixture.mode='unknown';});await main(page).click({button:'right'});await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Outcome not known');
  await page.getByRole('button',{name:'Check project list'}).click();await expect(page.getByRole('status').filter({hasText:'Nothing was sent again'})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).fixture.calls.length)).toBe(1);
});

test('a confirmed lost reply refreshes the project list without replaying it',async({page})=>{
  await page.evaluate(()=>{(window as any).fixture.mode='unknown-committed';});
  await main(page).click({button:'right'});await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Outcome not known');
  await expect(main(page)).toBeVisible();
  await page.getByRole('button',{name:'Check project list'}).click();
  await expect(main(page)).toHaveCount(0,{timeout:15_000});
  await expect(main(page,'Next project')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).fixture.calls.length)).toBe(1);
});

test('joined editor and viewer projections expose no project mutation actions',async({page})=>{
  for(const access of ['editor','viewer']){
    await page.evaluate(access=>{const f=(window as any).fixture;f.projects[0].access=access;f.projects[0].canUpdate=false;},access);
    // A reload constructs the fixture again, so use the app event to refresh the live projection.
    await page.evaluate(async()=>{await (window as any).backbone.call('projects.update',{id:'q',patch:{name:'Next project'}});});
    await expect(page.getByRole('button',{name:'Project actions for Launch plan',exact:true})).toHaveCount(0);
    await main(page).click({button:'right'});await expect(page.getByRole('menuitem',{name:'Rename',exact:true})).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
});

 test('Return renames a project and Escape returns focus to its row',async({page})=>{
  await main(page).focus();await main(page).press('Enter');const field=page.getByRole('textbox',{name:'Project name',exact:true});
  await expect(field).toBeFocused();await field.fill('Cancelled');await field.press('Escape');await expect(main(page)).toBeFocused();
 });
 test('archive offers Undo as a new restore request',async({page})=>{
  await main(page).click({button:'right'});await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Archived Launch plan.'})).toBeVisible();
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(main(page)).toBeVisible();await expect(main(page)).toBeFocused();
  expect(await page.evaluate(()=>(window as any).fixture.calls.map((c:any)=>c.patch))).toEqual([{archived:true},{archived:false}]);
 });
 test('search finds archived projects and chats and restores from the results',async({page},info)=>{
  await page.evaluate(()=>{const f=(window as any).fixture;f.projects[0].archived=true;f.threads[0].archived=true;f.emit();});
  await expect(main(page)).toHaveCount(0);await page.getByRole('button',{name:'Search chats',exact:true}).click();
  await page.getByRole('combobox').fill('Launch');await expect(page.getByRole('option',{name:/Launch plan.*Archived.*Restore/})).toBeVisible();
  if(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS)await page.screenshot({path:join(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS,`${info.project.name}-search-archived.png`)});
  await page.getByRole('option',{name:/Launch plan.*Archived.*Restore/}).click();await expect(page.getByRole('heading',{level:1})).toContainText('Launch plan');
 });
 test('an explicitly open archived project conversation survives events and offers Restore',async({page},info)=>{
  await page.evaluate(()=>{const f=(window as any).fixture;f.projects[0].archived=true;f.emit();});await expect(main(page)).toHaveCount(0);
  await page.evaluate(()=>{const f=(window as any).fixture;f.runs=[{id:'run',threadId:'t',title:'Scheduled result',outcome:'done',startedAt:new Date().toISOString()}];f.emit();});
  await page.getByRole('button',{name:'More',exact:true}).click();await page.getByRole('menuitem',{name:'Scheduled',exact:true}).click();
  await page.getByRole('button',{name:'Open chat',exact:true}).click();
  await expect(page.getByTestId('thread-title')).toHaveText('Project conversation');
  await page.evaluate(()=>(window as any).fixture.emit());await expect(page.getByTestId('thread-title')).toHaveText('Project conversation');
  await expect(page.getByText('This project is archived.',{exact:false})).toBeVisible();
  if(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS)await page.screenshot({path:join(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS,`${info.project.name}-archived-conversation.png`)});
  await page.getByRole('button',{name:'Restore project',exact:true}).click();await expect(page.getByText('This project is archived.',{exact:false})).toHaveCount(0);
 });
 test('all archived projects offer recovery instead of creating a default on send',async({page},info)=>{
  await page.evaluate(()=>{const f=(window as any).fixture;f.projects.forEach((p:any)=>p.archived=true);f.emit();});
  await expect(page.getByText('There is no active project.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'New project',exact:true}).last()).toBeVisible();
  if(page.viewportSize()!.width<768)await page.getByRole('button',{name:'Close sidebar',exact:true}).click();
  if(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS)await page.screenshot({path:join(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS,`${info.project.name}-no-active-project.png`)});
 });

 test('a thrown definite refusal leaves project actions available',async({page})=>{
  await page.evaluate(()=>(window as any).fixture.mode='thrown-refused');await main(page).click({button:'right'});await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
  const field=page.getByRole('textbox',{name:'Project name',exact:true});await field.fill('Retained');await field.press('Enter');
  await expect(page.getByRole('alert')).toContainText('refused');await expect(field).toBeEnabled();await expect(field).toHaveValue('Retained');
  await page.evaluate(()=>(window as any).fixture.mode='ok');await field.press('Enter');await expect(main(page,'Retained')).toBeVisible();
 });
 test('archive notice uses visible schedule and sharing facts, and pauses its dismissal while focused',async({page},info)=>{
  await page.evaluate(()=>{(window as any).fixture.schedules=[{id:'one',projectId:'p',paused:false},{id:'two',projectId:'p',paused:false},{id:'paused',projectId:'p',paused:true}];});
  await main(page).click({button:'right'});await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
  const notice=page.getByRole('status').filter({hasText:'Archived Launch plan.'});await expect(notice).toContainText('Its 2 schedules keep running. Ana keeps editor access.');
  await page.getByRole('button',{name:'Undo',exact:true}).focus();await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeFocused();
  await page.clock.install();await page.clock.runFor(13000);await expect(notice).toBeVisible();
  const dir=process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS;if(dir)await page.screenshot({path:join(dir,`${info.project.name}-undo.png`)});
  await page.getByRole('button',{name:'Dismiss notice',exact:true}).click();await expect(notice).toHaveCount(0);
 });
 test('archived chats can be restored directly in search',async({page})=>{
  await page.evaluate(()=>{const f=(window as any).fixture;f.threads[0].archived=true;f.emit();});
  await page.getByRole('button',{name:'Search chats',exact:true}).click();await page.getByRole('combobox').fill('Project conversation');
  await expect(page.getByTestId('search-hit')).toContainText('Archived');
  await page.getByTestId('search-hit').getByRole('button',{name:'Restore',exact:true}).click();await expect(page.getByTestId('thread-title')).toHaveText('Project conversation');
 });
 test('a joined window with no archived project omits the empty More menu',async({page})=>{
  await page.addInitScript(()=>{(window as any).startRemote=true;});await page.reload();
  if(page.viewportSize()!.width<768)await page.getByRole('button',{name:'Open sidebar',exact:true}).click();
  await expect(main(page)).toBeVisible();await expect(page.getByRole('button',{name:'More',exact:true})).toHaveCount(0);
 });

 test('Undo with a lost answer checks restoration without repeating either request',async({page})=>{
  await main(page).click({button:'right'});await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await page.evaluate(()=>(window as any).fixture.mode='unknown-committed');await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Outcome not known');await page.getByRole('button',{name:'Check project list'}).click();
  await expect(main(page)).toBeVisible();expect(await page.evaluate(()=>(window as any).fixture.calls.map((c:any)=>c.patch))).toEqual([{archived:true},{archived:false}]);
 });

 test('an archived conversation explains to a viewer who may restore its project',async({page},info)=>{
  await page.evaluate(()=>{const f=(window as any).fixture;Object.assign(f.projects[0],{archived:true,canUpdate:false,access:'viewer'});f.threads[0].access='viewer';f.emit();});
  await page.getByRole('button',{name:'Search chats',exact:true}).click();await page.getByRole('combobox').fill('Project conversation');await page.getByTestId('search-hit').click();
  await expect(page.getByTestId('thread-title')).toHaveText('Project conversation');await expect(page.getByText('The project owner can restore it.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Restore project',exact:true})).toHaveCount(0);
  await page.evaluate(()=>(window as any).fixture.emit());await expect(page.getByTestId('thread-title')).toHaveText('Project conversation');
  if(page.viewportSize()!.width<768)await expect(page.getByRole('button',{name:'Close sidebar',exact:true})).toBeHidden();
  if(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS)await page.screenshot({path:join(process.env.BACKBONE_PROJECT_ACTION_SCREENSHOTS,`${info.project.name}-archived-viewer.png`)});
 });

 for(const openChat of [false,true])test(openChat?'an explicitly open saved archived conversation survives startup':'startup repairs a stale archived new-chat selection',async({page})=>{
  await page.addInitScript(open=>{Object.assign(window,{startArchived:true,startOpenChat:open});},openChat);await page.reload();
  if(openChat){await expect(page.getByTestId('thread-title')).toHaveText('Project conversation');await expect(page.getByText('This project is archived.',{exact:false})).toBeVisible();await page.evaluate(()=>(window as any).fixture.emit());await expect(page.getByTestId('thread-title')).toHaveText('Project conversation');}
  else await expect(page.getByRole('heading',{level:1})).toContainText('Next project');
 });

 test('archive notices leave with the signed-in view when access ends',async({page})=>{
  await main(page).click({button:'right'});await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
  await page.evaluate(()=>(window as any).fixture.emit({topic:'identity',urgent:'Access ended'}));
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'Archived Launch plan.'})).toHaveCount(0);
 });

 test('archive notices leave active-project navigation available after a lost answer',async({page})=>{
  await page.evaluate(()=>(window as any).fixture.mode='unknown');await main(page).click({button:'right'});await page.getByRole('menuitem',{name:'Archive',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Outcome not known');
  await page.getByRole('button',{name:'Search chats',exact:true}).click();await page.getByRole('combobox').fill('Next project');
  const result=page.getByRole('option',{name:/Next project/});await expect(result).not.toHaveAttribute('aria-disabled','true');await result.click();
  await expect(page.getByRole('heading',{level:1})).toContainText('Next project');await expect(page.getByRole('alert')).toContainText('Outcome not known');
  expect(await page.evaluate(()=>(window as any).fixture.calls.length)).toBe(1);
 });
